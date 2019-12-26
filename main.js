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

const language = 'js';

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {

    let searchRateLimitRemaining, searchRatelimitReset;
    let apiRateLimitRemaining, apiRatelimitReset;

    function httpCallerBuilder(rateLimitRemaining, rateLimitReset, threshold) {
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

    const makeSearchCall = httpCallerBuilder(searchRateLimitRemaining, searchRatelimitReset, 5);
    const makeAPICall = httpCallerBuilder(apiRateLimitRemaining, apiRateLimitReset, 50);

    let repos = [];

    let request = {
	url: 'search/repositories',
	method: 'get',
	baseURL: 'https://api.github.com',
	headers: {
	    'Accept': 'application/vnd.github.v3+json',
	    'Authorization': `token ${githubToken}`,
	},
	params: {
	    'q': 'topic:serverless language:js',
	    'sort': 'stars',
	    'order': 'desc',
	    'per_page': 100,
	},
    }

    const linkRegex = /<(.*)>; rel="next"/;

    // Step 1: Determine the total number of elements, and all derived info

    let response;

    response = await makeSearchCall(request);
    try {
	response = await axios(request);

	searchRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
	searchRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;

    } catch (err) {
	console.error(err);
    }

    const maxBucketSize = 1000;
    const totalResults = response.data.total_count;
    const buckets = Math.ceil(totalResults/maxBucketSize);
    const minBucketSize = Math.ceil(totalResults/buckets);
    const maxStars = response.data.items[0].stargazers_count;

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
    	    try {
    		if (searchRateLimitRemaining < 5) {
    		    const timeToSleep = searchRatelimitReset*1000-Date.now();
    		    console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${searchRateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		    await sleep(timeToSleep);
    		}
    		response = await axios(request);

    		searchRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
    		searchRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;
    	    } catch (err) {
    		console.error(err);
    		return false;
    	    }

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

    	console.log(delimiters);
    }

    const delimiters = [ 0, 1, 18, 33587 ];

    // Step 3: Collect all repos

    for (let i = 0; i < buckets; i++) {
    	const minStars = delimiters[i], maxStars = delimiters[i+1]-1;
    	request.params.q = `topic:serverless language:js stars:${minStars}..${maxStars}`;

    	try {
    	    if (searchRateLimitRemaining < 5) {
    		const timeToSleep = searchRatelimitReset*1000-Date.now();
    		console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${searchRateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		await sleep(timeToSleep);
    	    }
    	    response = await axios(request);

    	    searchRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
    	    searchRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;
    	} catch (err) {
    	    console.error(err);
    	    return false;
    	}

    	console.log(`Ran request for star range ${minStars}..${maxStars}. Got ${response.data.total_count} results.`);

    	repos = repos.concat(response.data.items);
    	console.log(`Collected ${repos.length} repos.`);

    	let nextCallLink = response.headers.link;

    	while (nextCallLink && nextCallLink.match(linkRegex)) {
    	    const nextPageLink = nextCallLink.match(linkRegex)[1];

    	    if (searchRateLimitRemaining < 5) {
    		const timeToSleep = searchRatelimitReset*1000-Date.now();
    		console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${searchRateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		await sleep(timeToSleep);
    	    }

    	    const nextPageRequest = {
    		url: nextPageLink,
    		method: 'get',
    		headers: {
    		    'Accept': 'application/vnd.github.v3+json',
    		    'Authorization': `token ${githubToken}`,
    		},
    	    }
    	    try {
    		response = await axios(nextPageRequest);

    		searchRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
    		searchRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;
    	    } catch (err) {
    		console.error(err);
    		return false;
    	    }
    	    nextCallLink = response.headers.link;

    	    repos = repos.concat(response.data.items);
    	    console.log(`Collected ${repos.length} repos.`);
    	}
    }

    console.log(`Finished collecting repos. Total of ${repos.length} repos, out of an expected ${totalResults} repos.`);

    console.log('Writing to file...');
    fs.writeFileSync('repos.json', JSON.stringify(repos));
    console.log('Done.');

    console.log('Reading repos from file...');
    repos = JSON.parse(fs.readFileSync('repos.json'));
    console.log('Done.');

    // console.log(repos[0]);

    // Step 4: Iterate over repo. Only keep repos that have a serverless.yml file. Download the serverless.yml file.

    for (const repo of repos) {
    	request = {
    	    url: 'search/code',
    	    method: 'get',
    	    baseURL: 'https://api.github.com',
    	    headers: {
    		'Accept': 'application/vnd.github.v3+json',
    		'Authorization': `token ${githubToken}`,
    	    },
    	    params: {
    		'q': `filename:serverless.yml repo:${repo.full_name}`,
    		'per_page': 100,
    	    },
    	}

	try {
	    if (searchRateLimitRemaining < 5) {
    		const timeToSleep = searchRatelimitReset*1000-Date.now();
    		console.log(`Nearing the edge of allowed rate. Current remaining allowed calls: ${searchRateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		await sleep(timeToSleep);
    	    }

	    response = await axios(request);

	    searchRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
	    searchRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;

	} catch (err) {
	    console.error(err);
	}

	if (response.data.total_count > 0) {
	    console.log(`YES! Repo ${repo.full_name} (${repo.html_url}) contains a serverless.yml file.`)
	} else {
	    console.log(`no.. Repo ${repo.full_name} (${repo.html_url}) does not contain a serverless.yml file.`)
	}

    }

    const blobUrlList = response.data.items.map(item => item.git_url);

    for (const blobUrl of blobUrlList) {
    	const blobRequest = {
    	    url: blobUrl,
    	    method: 'get',
    	    headers: {
    		'Accept': 'application/vnd.github.v3+json',
    		'Authorization': `token ${githubToken}`,
    	    },
    	}

    	try {
    	    if (apiRateLimitRemaining < 50) {
    		const timeToSleep = apiRatelimitReset*1000-Date.now();
    		console.log(`Nearing the edge of allowed rate. Current remaining allowed API calls: ${apiRateLimitRemaining}. Sleeping until rate resets, ${timeToSleep}ms.`);
    		await sleep(timeToSleep);
    	    }

    	    response = await axios(blobRequest);

    	    apiRateLimitRemaining = Number(response.headers['x-ratelimit-remaining']);
    	    apiRatelimitReset = Number(response.headers['x-ratelimit-reset']) ;

    	} catch (err) {
    	    console.error(err);
    	}

    	const slsConf = yaml.safeLoad(Buffer.from(response.data.content, response.data.encoding).toString());
	console.log(slsConf);
    }
}

main();
