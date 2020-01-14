const axios = require('axios');
const aws = require('aws-sdk');
const fs = require('fs');
const _ = require('lodash');
const yaml = require('yaml');


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
    const fullDate = (new Date()).toISOString();

    // '2020-01-08T15:34:47.756Z'
    const dateRE = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}).\d{3}Z/;

    return fullDate.match(dateRE)[1];
}

async function sleep(ms) {
    if (ms > 60000) {
	for (let i = 0; i < ms; i+=1000) {
	    await new Promise(resolve => setTimeout(resolve, 1000));
	    process.stdout.write('.');
	}
	console.log();
    } else {
	return new Promise(resolve => setTimeout(resolve, ms));
    }
}

const requestHeaders = {
    'Accept': 'application/vnd.github.v3+json',
    'Authorization': `token ${githubToken}`,
};

function httpCallerBuilder(threshold) {
    let rateLimitRemaining;
    let rateLimitReset;

    return async function makeHttpCall(request) {
	let retries = 5;
	while (retries > 0) {
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

		retries = 0;

		return response;
            } catch (err) {
		console.log('Request failed!');
		console.log(err);

		console.log('Sleeping for 5min before retrying request.');
		await sleep(300000);

		retries--;
		console.log(`Retrying. Retries remaining: ${retries}`);
            }
	} 
	console.log('Failed 5 retries. Exiting!');
	process.exit(1);
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

// Iterate over repos. Only keep repos that have a serverless.yml file. Download
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
        process.stdout.write('.');
    }

    console.log(`${slsRepos.length} repos contain serverless.yml files, out of a total of ${repos.length}.`);

    return { slsRepos, yamlFiles };

}

module.exports.getSearchBounds = getSearchBounds;
module.exports.findBucketDelimiters = findBucketDelimiters;
module.exports.collectRepos = collectRepos;
module.exports.collectSlsFiles = collectSlsFiles;
module.exports.analyze = analyze;

async function fullRun() {
    const dir = `run-${getTimestampString()}`;
    fs.mkdirSync(`./collected-data/${dir}`, {recursive: true});

    // Full flow
    let repos = [];
    for (const topic of topics) {
        console.log(`Collecting repos for topic:${topic}`);

        const searchBounds = await getSearchBounds(topic, language);
        const delimiters = await findBucketDelimiters(searchBounds, topic, language);
        repos = repos.concat(await collectRepos(delimiters, searchBounds, topic, language));

        // Uncomment this in case we encounter github's abuse policy again
        console.log(`Taking a break. Sleeping for half an hour to avoid triggering github's abuse policy.`)
	await sleep(1800000);
    };

    console.log(`Collected a total of ${repos.length} repos.`);
    repos = _.uniqBy(repos, elem => elem.id);
    console.log(`After filtering out duplicates, have a total of ${repos.length} repos.`);

    console.log('Writing all collected repos to file...');
    fs.writeFileSync(`./collected-data/${dir}/all-repos.json`, JSON.stringify(repos));
    console.log('Done.');

    const repoChunks = Array(Math.ceil(repos.length / 250))
          .fill()
          .map((_, index) => index * 250)
          .map(begin => repos.slice(begin, begin + 250));

    for (let i = 0; i < repoChunks.length; i++) {
        const chunk = repoChunks[i];

        const { slsRepos, yamlFiles } = await collectSlsFiles(chunk);

        console.log(`Writing chunk ${i} (of ${repoChunks.length}) sls repos to file...`);
        fs.writeFileSync(`./collected-data/${dir}/sls-repos-${i}of${repoChunks.length}.json`, JSON.stringify(slsRepos));
        console.log('Done.');

        console.log(`Writing chunk ${i} (of ${repoChunks.length}) conf file mapping to file...`);
        fs.writeFileSync(`./collected-data/${dir}/yaml-file-mapping-${i}of${repoChunks.length}.json`, JSON.stringify(yamlFiles));
        console.log('Done.');

        console.log(`Taking a break. Sleepng for half an hour to avoid triggering github's abuse policy.`)
	await sleep(1800000);
    }
}

async function analyze(dir) {
    const repos = JSON.parse(fs.readFileSync(`./collected-data/${dir}/sls-repos.json`));
    const yamlMapping = JSON.parse(fs.readFileSync(`./collected-data/${dir}/yaml-file-mapping.json`));

    const res = repos.map(repo => ({repo, files: (yamlMapping.find(elem => elem.id === repo.id)).files }))
          .filter(({ repo, files }) =>  files.some(file => {try {yaml.parse(file); return true;} catch (err) {return false;}} ) )
          .map(({ repo, files }) => ({repo, files: files.filter(file => {try {yaml.parse(file); return true;} catch (err) {return false;}})}))
          .map(({ repo, files }) => ({repo, files: files.map(file => yaml.parse(file))}))
          .map(({ repo, files }) => ({id: repo.id,
                                      full_name: repo.full_name,
                                      html_url: repo.html_url,
                                      description: repo.description,
                                      ssh_url: repo.ssh_url,
                                      clone_url: repo.clone_url,
                                      stargazers_count: repo.stargazers_count,
                                      watchers_count: repo.watchers_count,
                                      forks_count: repo.forks_count,
                                      fork: repo.fork,
                                      function_count: files.map(file => file && file.functions ? Object.keys(file.functions).length : 0).reduce((a,b) => a + b, 0),
                                      resources: _.uniq(files.filter(file => file && file.resources && file.resources.Resources)
                                                        .map(file => Object.values(file.resources.Resources).map(elem => elem.Type))
                                                        .flat()),
                                      files
                                     }));

    console.log('Writing data to file...');
    fs.writeFileSync(`./collected-data/${dir}/data.json`, JSON.stringify(repos));
    console.log('Done.');

}

async function increment(dir) {}

async function recover(dir) {}

if (require.main === module) {

    require('yargs')
	.usage('Usage: $0 <command> [options]')
	.command(['full', 'f'],
		 'A full execution of the project collector',
		 () => {},
		 (argv) => fullRun()
		)
    	.command(['analyze <dir>', 'a'],
		 'Run an analysis of the collected results',
		 (yargs) => {
		     yargs.positional('dir', {
			 describe: 'A directory containing the raw github data to be analyzed',
			 type: 'string'
		     })},
		 (argv) => analyze(argv.dir)
		)
        .command(['increment <dir>', 'i'],
		 'Collect and process newly update porjects',
		 (yargs) => {
		     yargs.positional('dir', {
			 describe: 'A directory containing the results that are to be incremented upon',
			 type: 'string'
		     })
		 },
		 (argv) => increment(argv.dir)
		)
	.command(['recover <dir>', 'r'],
		 'Recover from a previously unfinished run',
		 (yargs) => {
		     yargs.positional('dir', {
			 describe: 'A directory containing the results of a partial run',
			 type: 'string'
		     })
		 },
		 (argv) => recover(argv.dir)
		)
	.alias('h','help')
	.argv;

}


