const axios = require('axios');
const aws = require('aws-sdk');
const fs = require('fs');
const yaml = require('js-yaml');

const githubToken = process.env.GITHUB_API_TOKEN;
const verbose = process.env.PROJECT_COLLECTOR_VERBOSE;

if (verbose) {
    axios.interceptors.request.use(request => {
	console.log('Starting Request', axios.getUri(request));
	return request;
    });

    // axios.interceptors.response.use(response => {
    // 	console.log('Response:', response)
    // 	return response
    // })
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
	let rateLimitRemaining, rateLimitReset;

	return async function makeHttpCall(request) {
    	    try {
    		if (rateLimitRemaining < threshold) {
    		    const timeToSleep = ratelimitReset*1000-Date.now();
    		    console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${rateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		    await sleep(timeToSleep);
    		}
    		const response = await axios(request);

    		rateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
    		ratelimitReset = Number(response.headers['x-ratelimit-reset']) ;

		return response;
    	    } catch (err) {
    		console.error(err);
		process.exit(1);
    	    }
	}
    }

    const makeSearchCall = httpCallerBuilder(5);
    const makeAPICall = httpCallerBuilder(50);

    let repos = [];

    let request = {
	url: 'search/repositories',
	method: 'get',
	baseURL: 'https://api.github.com',
	headers: requestHeaders,
	params: {
	    'q': 'topic:serverless language:js',
	    'sort': 'stars',
	    'order': 'desc',
	    'per_page': 100,
	},
    }

    const linkRegex = /<(.*)>; rel="next"/;

    // Step 1: Determine the total number of elements, and all derived info


    const step1response = await makeSearchCall(request);

    const maxBucketSize = 1000;
    const totalResults = step1response.data.total_count;
    const buckets = Math.ceil(totalResults/maxBucketSize);
    const minBucketSize = Math.ceil(totalResults/buckets);
    const maxStars = step1response.data.items[0].stargazers_count;

    console.log(
`
Initial call to search.
  Got ${totalResults} results.
  Should split into ${buckets} buckets, sized [${minBucketSize}..${maxBucketSize}].
  The project with the most stars has ${maxStars} stars.
`);

    // Step 2: Split into buckets
    // There are several edge cases I'm not handling at the moment. Will handle if encountered.
    //   1. star range singleton sized too big for bucket
    //   2. star range of singleton too small for bucket, whereas star range of size 2 too big for bucket.
    const delimiters = [0, maxStars+1]; // Delimiters form ranges of [from..to) (including from, excluding to).
    for (let i = 0; i < buckets-1; i++) {
    	const min = delimiters[i], max = delimiters[i+1]-1;
    	let latestMin = min, latestMax = max;
    	let loc = Math.ceil((max+min)/2);
    	let currBucketSize = 0;

    	while (currBucketSize < minBucketSize || currBucketSize > maxBucketSize) {
    	    request.params.q = `topic:serverless language:js stars:${min}..${loc}`;
	    const step2response = await makeSearchCall(request);

    	    currBucketSize = step2response.data.total_count;

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

    // Step 3: Collect all repos

    for (let i = 0; i < buckets; i++) {
    	const minStars = delimiters[i], maxStars = delimiters[i+1]-1;
    	request.params.q = `topic:serverless language:js stars:${minStars}..${maxStars}`;

	const step3firstresponse = await makeSearchCall(request);

    	console.log(`Ran request for star range ${minStars}..${maxStars}. Got ${step3firstresponse.data.total_count} results.`);

    	repos = repos.concat(step3firstresponse.data.items);
    	console.log(`Collected ${repos.length} repos.`);

    	let nextCallLink = step3firstresponse.headers.link;

    	while (nextCallLink && nextCallLink.match(linkRegex)) {
    	    const nextPageLink = nextCallLink.match(linkRegex)[1];

	    const nextPageRequest = {
    		url: nextPageLink,
    		method: 'get',
    		headers: requestHeaders,
    	    }

	    const step3response = await makeSearchCall(nextPageRequest);

    	    nextCallLink = step3response.headers.link;

    	    repos = repos.concat(step3response.data.items);
    	    console.log(`Collected ${repos.length} repos.`);
    	}
    }

    console.log(`Finished collecting repos. Total of ${repos.length} repos, out of an expected ${totalResults} repos.`);

    console.log('Writing all collected repos to file...');
    fs.writeFileSync(`all-repos-${getTimestampString()}.json`, JSON.stringify(repos));
    console.log('Done.');

    // Step 4: Iterate over repo. Only keep repos that have a serverless.yml file. Download the serverless.yml file.

    const slsRepos = [];
    const yamlFiles = {};

    for (const repo of repos) {
    	request = {
    	    url: 'search/code',
    	    method: 'get',
    	    baseURL: 'https://api.github.com',
    	    headers: requestHeaders,
    	    params: {
    		'q': `filename:serverless.yml repo:${repo.full_name}`,
    		'per_page': 100,
    	    },
    	}

	const step4firstresponse = await makeSearchCall(request);

	if (step4firstresponse.data.total_count > 0) {
	    slsRepos.push(repo);

	    const repoYamlFiles = [];

	    const fileUrlList = step4firstresponse.data.items.map(item => item.git_url);

	    for (const fileUrl of fileUrlList) {
    		const fileRequest = {
    		    url: fileUrl,
    		    method: 'get',
    		    headers: requestHeaders,
    		}

		const step4response = await makeAPICall(fileRequest);

    		const slsConf = yaml.safeLoad(Buffer.from(step4response.data.content, step4response.data.encoding).toString());
		repoYamlFiles.push(slsConf);
	    }

	    yamlFiles.id = repo.id;
	    yamlFiles.files = repoYamlFiles;
	}
    }

    console.log(`${slsRepos.length} repos contain serverless.yml files, out of a total of ${repos.length}.`);

    console.log('Writing sls repos to file...');
    fs.writeFileSync(`sls-repos-${getTimestampString()}.json`, JSON.stringify(slsRepos));
    console.log('Done.');

    console.log('Writing conf file mapping to file...');
    fs.writeFileSync(`yaml-file-mapping-${getTimestampString()}.json`, JSON.stringify(yamlFiles));
    console.log('Done.');
}

main();
