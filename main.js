const axios = require('axios');
const aws = require('aws-sdk');
const fs = require('fs');

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

function getTimestampString() {
    const d = new Date();

    return `${d.getFullYear()}-${d.getMonth()}-${d.getDay()}-${d.getHours()}${d.getMinutes()}${d.getSeconds()}`;
}

const language = 'js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

const requestHeaders = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${githubToken}`,
};

async function main() {

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

    /* ******************************************************** *
     * Initial call to the search API.
     *   Determine the total number of elements in the search,
     *   and derive the number of buckets, and the size bounds
     *   of each bucket.
     * ******************************************************** */
    async function getSearchBounds(topic = 'serverless', lang = 'js') {
        const request = {
            url: 'search/repositories',
            method: 'get',
            baseURL: 'https://api.github.com',
            headers: requestHeaders,
            params: {
                'q': `topic:${topic} language:${lang}`,
                'sort': 'stars',
                'order': 'desc',
                'per_page': 100,
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

    /* *************************************************************** *
     *  Split into buckets
     *   There are several edge cases I'm not handling at the
     *   moment. Will handle if encountered.
     *     1. star range singleton sized too big for bucket
     *     2. star range of singleton too small for bucket, whereas star
     *        range of size 2 too big for bucket.
     * *************************************************************** */
    async function findBucketDelimiters(searchBounds, topic = 'serverless', lang = 'js') {
        const request = {
            url: 'search/repositories',
            method: 'get',
            baseURL: 'https://api.github.com',
            headers: requestHeaders,
            params: {
                'sort': 'stars',
                'order': 'desc',
                'per_page': 100,
            },
        }

        const {maxStars, buckets, minBucketSize, maxBucketSize} = searchBounds;

        const delimiters = [0, maxStars+1]; // Delimiters form ranges of [from..to) (including from, excluding to).
        for (let i = 0; i < buckets-1; i++) {
            const min = delimiters[i], max = delimiters[i+1]-1;
            let latestMin = min, latestMax = max;
            let loc = Math.ceil((max+min)/2);
            let currBucketSize = 0;

            while (currBucketSize < minBucketSize || currBucketSize > maxBucketSize) {
                request.params.q = `topic:${topic} language:${lang} stars:${min}..${loc}`;
                const response = await makeSearchCall(request);

                currBucketSize = response.data.total_count;

                console.log(`Ran request for star range ${min}..${loc}. Got ${currBucketSize} results.`);

                if (currBucketSize > maxBucketSize) {
                    latestMax = loc;
                    loc = Math.floor((latestMin+loc)/2);
                } else if (currBucketSize < minBucketSize) {
                    latestMin = loc;
                    loc = Math.ceil((loc+latestMax)/2);
                }
            }
            delimiters.splice(i+1,0,loc+1)
        }
        console.log(`Bucket delimiters: ${delimiters}`)

        return delimiters;
    }

    /* *************************************************************** *
     *  Collect all repos
     * *************************************************************** */
    async function collectRepos(delimiters, searchBounds, topic = 'serverless', lang = 'js') {
        let repos = [];
        const request = {
            url: 'search/repositories',
            method: 'get',
            baseURL: 'https://api.github.com',
            headers: requestHeaders,
            params: {
                'sort': 'stars',
                'order': 'desc',
                'per_page': 100,
            },
        }
        const {buckets, totalResults} = searchBounds;

        for (let i = 0; i < buckets; i++) {
            const minStars = delimiters[i], maxStars = delimiters[i+1]-1;
            request.params.q = `topic:${topic} language:${lang} stars:${minStars}..${maxStars}`;

            let response = await makeSearchCall(request);

            console.log(`Ran request for star range ${minStars}..${maxStars}. Got ${response.data.total_count} results.`);

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
        }

        console.log(`Finished collecting repos. Total of ${repos.length} repos, out of an expected ${totalResults} repos.`);

        console.log('Writing all collected repos to file...');
        fs.writeFileSync(`all-repos-${getTimestampString()}.json`, JSON.stringify(repos));
        console.log('Done.');

        return repos;
    }

    /* ***************************************************************
     * Iterate over repo. Only keep repos that have a serverless.yml
     *  file. Download all serverless.yml files.
     * *************************************************************** */
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
	    if (counter % 400 === 0) {
		console.log(`Taking a break. Sleeping for two hours to avoid triggering github's abuse policy.`)
		await sleep(7200000);
	    }
        }

        console.log(`${slsRepos.length} repos contain serverless.yml files, out of a total of ${repos.length}.`);

        console.log('Writing sls repos to file...');
        fs.writeFileSync(`sls-repos-${getTimestampString()}.json`, JSON.stringify(slsRepos));
        console.log('Done.');

        console.log('Writing conf file mapping to file...');
        fs.writeFileSync(`yaml-file-mapping-${getTimestampString()}.json`, JSON.stringify(yamlFiles));
        console.log('Done.');

        return { slsRepos, yamlFiles };

    }


    // Full flow
    // topic = 'serverless', lang = 'js'
    // const searchBounds = await getSearchBounds();
    // const delimiters = await findBucketDelimiters(searchBounds);
    // const repos = await collectRepos(delimiters, searchBounds);

    const repos = JSON.parse(fs.readFileSync('all-repos-2019-11-1-225758.json'));
    const { slsRepos, yamlFiles } = await collectSlsFiles(repos);
}

main();
