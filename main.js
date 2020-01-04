const axios = require('axios');
const aws = require('aws-sdk');
const fs = require('fs');
var _ = require('lodash');

const githubToken = process.env.GITHUB_API_TOKEN;
const verbose = process.env.PROJECT_COLLECTOR_VERBOSE;

if (verbose) {
    axios.interceptors.request.use(request => {
        console.log('Starting Request', axios.getUri(request));
        return request;
    });

    axios.interceptors.response.use(response => {
        console.log(`Remaining API calls: ${response.headers['x-ratelimit-remaining']}. Resets in ${Number(response.headers['x-ratelimit-reset']-Date.now()/1000)}s.`);
        return response
    });
}


const topics = [
    'serverless',
    'lambda',
    'aws-lambda',
];
const language = 'js';

function getTimestampString() {
    const d = new Date();

    return `${d.getFullYear()}-${d.getMonth()+1}-${d.getDate()}-${d.getHours()}${d.getMinutes()}${d.getSeconds()}`;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const requestHeaders = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${githubToken}`,
};

function httpCallerBuilder(threshold) {
    let rateLimitRemaining;
    let rateLimitReset;

    return async function makeHttpCall(request) {
        try {
            if (rateLimitRemaining < threshold) {
                const timeToSleep = rateLimitReset*1000-Date.now();
                console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${rateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
                await sleep(timeToSleep);
            }
            const response = await axios(request);

            rateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
            rateLimitReset = Number(response.headers['x-ratelimit-reset']) ;

            if (verbose) {
                console.log(`Got response from call with ${threshold} threshold. New rateLimitRemaining is ${rateLimitRemaining}. New rateLimitReset is ${rateLimitReset} (in ${rateLimitReset-Date.now()/1000}s).`)
            }

            return response;
        } catch (err) {
            console.error(err);
            process.exit(1);
        }
    }
}

const makeSearchCall = httpCallerBuilder(5);
const makeAPICall = httpCallerBuilder(50);

const linkRegex = /<(.*)>; rel="next"/;

// Initial call to the search API.
//   Determine the total number of elements in the search, and derive the number
//   of buckets, and the size bounds of each bucket.

async function getSearchBounds(topic, lang) {
    const request = {
        url: 'search/repositories',
        method: 'get',
        baseURL: 'https://api.github.com',
        headers: requestHeaders,
        params: {
            'q': `topic:${topic} language:${lang}`,
            'sort': 'stars',
            'order': 'desc',
            'per_page': 5,
        },
    }

    const response = await makeSearchCall(request);

    const res = {
        maxBucketSize: 1000,
        totalResults: response.data.total_count,
        maxStars: response.data.items[0].stargazers_count,
    };

    res.buckets = Math.ceil(res.totalResults/res.maxBucketSize);
    res.minBucketSize = Math.ceil(res.totalResults/res.buckets);


    console.log(
        `
Initial call to search.
  Got ${res.totalResults} results.
  Should split into ${res.buckets} buckets, sized [${res.minBucketSize}..${res.maxBucketSize}].
  The project with the most stars has ${res.maxStars} stars.
`);
    return res;
}

// Split into buckets
//   The dataset is bottom heavy, i.e., many 0-star repos. Makes sense to do a
//   bottom up partitioning of the search space.

async function findBucketDelimiters(searchBounds, topic, lang) {
    const request = {
        url: 'search/repositories',
        method: 'get',
        baseURL: 'https://api.github.com',
        headers: requestHeaders,
        params: {
            // Don't waste time sorting
            // 'sort': 'stars',
            // 'order': 'desc',
            'per_page': 5, // I don't actually care about the results
                           // at this point, just the total number of
                           // results.
        },
    }

    const {maxStars, minBucketSize, maxBucketSize} = searchBounds;
    let totalResults = searchBounds.totalResults;

    const delimiters = [0]; // Delimiters form ranges of [from..to) (including from, excluding to).
    let from = 0;
    while (totalResults > maxBucketSize) {
        let to = from;

        let currBucketSize;

        let lowerBound = from;
        let upperBound = maxStars;

        do {
            request.params.q = `topic:${topic} language:${lang} stars:${from}..${to}`;
            const response = await makeSearchCall(request);
            currBucketSize = response.data.total_count;

            console.log(`Ran request for star range ${from}..${to}. Got ${currBucketSize} results.`);

            if (currBucketSize < minBucketSize) { // Keep increasing the size of the bucket
                lowerBound = to;

                if (upperBound < maxStars) { // Overshot at some point. Searching within bounds.
                    to = Math.ceil((to+upperBound)/2);
                } else {
                    to = Math.min(to === 0 ? 1 : to * 2, upperBound);
                }

                if (lowerBound === to) { // Reached fixed-point. Fix by creating an additional, undersized bucket.
                    searchBounds.buckets += 1;
                    console.log(`Detected an underfull bucket. Star range: ${from}..${to}. Size: ${currBucketSize}. New bucket count: ${searchBounds.buckets}.`);
                    break;
                }
            } else if (currBucketSize > maxBucketSize) { // Overshot. Reduce.
                upperBound = to;

                to = Math.floor((lowerBound+to)/2);

                if (upperBound === to) { // Reached fixed-point. Can't create a bucket that is
					 // smaller than the search size limit. Instead, handle when
					 // fetching repos.
                    console.log(`Detected an overfull bucket. Star range: ${from}..${to}. Size: ${currBucketSize}.`)
                    break;
                }
            }

        } while (currBucketSize < minBucketSize ||
                 currBucketSize > maxBucketSize);

        delimiters.push(to+1);
        totalResults -= currBucketSize;
        from = to+1;
    }

    delimiters.push(maxStars+1);

    console.log(`Bucket delimiters: ${delimiters}\n`);

    return delimiters;
}

// Collect all repos
//
//   When encountering an overfull bucket, use 'updated_at' to
//   get the next set of repos.
//   This makes the reasonable (?) assumption that the data does not include two
//   repos that were updated at the exact same millisecond. If they exist, some
//   of them might not be recorded in the dataset.
async function collectRepos(delimiters, searchBounds, topic, lang) {
    let repos = [];
    const request = {
        url: 'search/repositories',
        method: 'get',
        baseURL: 'https://api.github.com',
        headers: requestHeaders,
        params: {
            'sort': 'updated',
            'order': 'desc',
            'per_page': 100,
        },
    }
    const {buckets, totalResults} = searchBounds;

    for (let i = 0; i < buckets; i++) {
        const minStars = delimiters[i], maxStars = delimiters[i+1]-1;

	let timestamp;

	do {
            request.params.q = `topic:${topic} language:${lang} stars:${minStars}..${maxStars} ${timestamp ? "updated:<" : ''}${timestamp ? timestamp : ''}`;

            let response = await makeSearchCall(request);

            console.log(`Ran request for star range ${minStars}..${maxStars}${timestamp?' and timestamp <':''}${timestamp?timestamp:''}. Got ${response.data.total_count} results.`);

            repos = repos.concat(response.data.items);
            console.log(`Collected ${repos.length} repos.`);

            let nextCallLink = response.headers.link;

            while (nextCallLink && nextCallLink.match(linkRegex)) {
		const nextPageLink = nextCallLink.match(linkRegex)[1];

		const nextPageRequest = {
                    url: nextPageLink,
                    method: 'get',
                    headers: requestHeaders,
		}

		response = await makeSearchCall(nextPageRequest);

		nextCallLink = response.headers.link;

		repos = repos.concat(response.data.items);
		console.log(`Collected ${repos.length} repos.`);
            }

	    if (response.data.total_count > 1000) {
		console.log(`Oversized bucket encountered. Proceeding to get the rest of the repos in the bucket`);
		const earliestRepo = response.data.items[response.data.items.length-1];
		timestamp = earliestRepo.pushed_at;
	    } else {
		timestamp = undefined;
	    }
	} while (timestamp); // Use the existence of a timestamp as a flag for whether another iteration is required for this bucket.
    }

    console.log(`Finished collecting repos. Total of ${repos.length} repos, out of an expected ${totalResults} repos.`);

    return repos;
}

// Iterate over repo. Only keep repos that have a serverless.yml file. Download
// all serverless.yml files.
async function collectSlsFiles(repos) {
    const slsRepos = [];
    const yamlFiles = [];

    let counter = 0;

    for (const repo of repos) {
        const request = {
            url: 'search/code',
            method: 'get',
            baseURL: 'https://api.github.com',
            headers: requestHeaders,
            params: {
                'q': `filename:serverless.yml repo:${repo.full_name}`,
                'per_page': 100,
            },
        }

        const codeSearchResponse = await makeSearchCall(request);

        if (codeSearchResponse.data.total_count > 0) {
            slsRepos.push(repo);

            const repoYamlFiles = [];

            const fileUrlList = codeSearchResponse.data.items.map(item => item.git_url);

            for (const fileUrl of fileUrlList) {
                const fileRequest = {
                    url: fileUrl,
                    method: 'get',
                    headers: requestHeaders,
                }

                const fileResponse = await makeAPICall(fileRequest);

                repoYamlFiles.push(Buffer.from(fileResponse.data.content, fileResponse.data.encoding).toString());
            }

            yamlFiles.push({id: repo.id, files: repoYamlFiles});
        }

        counter++;
        if (counter % 20 === 0) {
            console.log(`Processed ${counter} repos. ${slsRepos.length}/${counter} contain sls yaml files.`);
        }
	if (counter % 50 === 0) {
	    console.log(`Taking a break. Sleeping for half an hour to avoid triggering github's abuse policy.`)
	    await sleep(108000);
	}
    }

    console.log(`${slsRepos.length} repos contain serverless.yml files, out of a total of ${repos.length}.`);

    return { slsRepos, yamlFiles };

}


async function collectFullData() {
    // Full flow
    let repos = [];
    for (const topic of topics) {
        console.log(`Collecting repos for topic:${topic}`);

        const searchBounds = await getSearchBounds(topic, language);
        const delimiters = await findBucketDelimiters(searchBounds, topic, language);
        repos = repos.concat(await collectRepos(delimiters, searchBounds, topic, language));

        // Uncomment this in case we encounter github's abuse policy again
        console.log(`Taking a break. Sleeping for half an hour to avoid triggering github's abuse policy.`)
	await sleep(108000);
    };

    console.log(`Collected a total of ${repos.length} repos.`);
    repos = _.uniqBy(repos, elem => elem.id);
    console.log(`After filtering out duplicates, have a total of ${repos.length} repos.`);

    console.log('Writing all collected repos to file...');
    fs.writeFileSync(`all-repos-${getTimestampString()}.json`, JSON.stringify(repos));
    console.log('Done.');

    const { slsRepos, yamlFiles } = await collectSlsFiles(repos);

    console.log('Writing sls repos to file...');
    fs.writeFileSync(`sls-repos-${getTimestampString()}.json`, JSON.stringify(slsRepos));
    console.log('Done.');

    console.log('Writing conf file mapping to file...');
    fs.writeFileSync(`yaml-file-mapping-${getTimestampString()}.json`, JSON.stringify(yamlFiles));
    console.log('Done.');
}

async function collectIncrementalData() {


}

collectFullData();
