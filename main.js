const axios = require('axios');
const aws = require('aws-sdk');
const githubToken = process.env.GITHUB_API_TOKEN;

const keywords = [
    'serverless',
    'lambda',
    'aws-lambda',
    'aws_lambda',
    'aws+lambda',
];

const language = 'js';

async function main() {
    const request = {
	url: 'search/repositories',
	// url: 'repositories',
	method: 'get',
	baseURL: 'https://api.github.com',
	headers: {
	    'Accept': 'application/vnd.github.v3+json',
	    // application/vnd.github.mercy-preview+json
	    'Authorization': `token ${githubToken}`,
	},
	params: {
	    // 'q': 'serverless',
	    // 'q': 'tetris+language:assembly',
	    // 'q': 'topic:serverless+stars:300..500',
	    // 'q': 'language:js+stars:300..500',
	    'q': 'serverless+language:js',
	    // 'q': 'a+language:javascript+topic:aws',
	    // 'sort': 'updated',
	    // 'order': 'desc',
	    'per_page': 100,
	},
    }

    try {
	const response = await axios(request);
	debugger;

	const ratelimitRemaining = Number(response.headers['x-ratelimit-remaining']);
	const ratelimitReset = Number(response.headers['x-ratelimit-reset']) ;

	const nextCall = response.headers.link

	console.log(`Remaining API calls: ${ratelimitRemaining}. Rate resets in ${(ratelimitReset-Math.floor(Date.now()/1000))/60}m.`)
	console.log(`# results found: ${response.data.total_count}`);
	console.log(nextCall);
	console.log(response.data.items.length);
    } catch (err) {
	console.log('ERROR!');
	console.log(err);
    }



}

main();

// z = { date: 'Wed, 25 Dec 2019 16:12:52 GMT',
//       'content-type': 'application/json; charset=utf-8',
//       'content-length': '418142',
//       connection: 'close',
//       server: 'GitHub.com',
//       status: '200 OK',
//       'x-ratelimit-limit': '5000',
//       'x-ratelimit-remaining': '4998',
//       'x-ratelimit-reset': '1577293971',
//       'cache-control': 'private, max-age=60, s-maxage=60',
//       vary:
//       'Accept, Authorization, Cookie, X-GitHub-OTP, Accept-Encoding',
//       etag: '"a290a559cfd39dc3f74e7481c22fe31f"',
//       'x-oauth-scopes': 'read:gpg_key, read:public_key, read:repo_hook, repo, user',
//       'x-accepted-oauth-scopes': '',
//       'x-github-media-type': 'github.v3; format=json',
//       link:
//       'https://api.github.com/repositories?since=369>; rel="next", https://api.github.com/repositories{?since}>; rel="first"',
//       'access-control-expose-headers':
//       'ETag, Link, Location, Retry-After, X-GitHub-OTP, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset, X-OAuth-Scopes, X-Accepted-OAuth-Scopes, X-Poll-Interval, X-GitHub-Media-Type',
//       'access-control-allow-origin': '*',
//       'strict-transport-security': 'max-age=31536000; includeSubdomains; preload',
//       'x-frame-options': 'deny',
//       'x-content-type-options': 'nosniff',
//       'x-xss-protection': '1; mode=block',
//       'referrer-policy': 'origin-when-cross-origin, strict-origin-when-cross-origin',
//       'content-security-policy': 'default-src \'none\'',
//       'x-github-request-id': 'EFC2:1B643:AD582D1:CDD57CA:5E038A83' }




// curl https://api.github.com/search/repositories?q=tetris+language:assembly&sort=stars&order=desc
