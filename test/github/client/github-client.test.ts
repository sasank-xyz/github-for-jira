/* eslint-disable @typescript-eslint/no-var-requires */
/* eslint-disable jest/no-standalone-expect */

import GitHubClient from "../../../src/github/client/github-client";
import AppTokenHolder from "../../../src/github/client/app-token-holder";
import InstallationTokenCache from "../../../src/github/client/installation-token-cache";
import fs from "fs";

describe("GitHub Client", () => {

	const privateKeyBase64 = fs.readFileSync("./test/github/client/dummy.key", "utf-8");
	const privateKey = Buffer.from(privateKeyBase64, "base64").toString("ascii");
	const appTokenExpirationDate = new Date(2021, 10, 25, 0, 0);
	const githubInstallationId = 17979017;
	const appTokenCache = new AppTokenHolder(privateKey, "106838");
	const installationTokenCache = new InstallationTokenCache(1000);

	function givenGitHubReturnsInstallationToken(installationToken: string, expectedAppTokenInHeader?: string) {
		githubNock
			.post(`/app/installations/${githubInstallationId}/access_tokens`)
			.matchHeader("Authorization", expectedAppTokenInHeader ? `Bearer ${expectedAppTokenInHeader}` : /^Bearer .+$/)
			.matchHeader("Accept", "application/vnd.github.v3+json")
			.reply(200, {
				expires_at: appTokenExpirationDate.toISOString(),
				token: installationToken
			});
	}

	function givenGitHubReturnsPullrequests(owner: string, repo: string, perPage: number, page: number, expectedInstallationTokenInHeader?: string) {
		githubNock
			.get(`/repos/${owner}/${repo}/pulls`)
			.query({
				per_page: perPage,
				page,
				installationId: /^.*$/
			})
			.matchHeader("Authorization", expectedInstallationTokenInHeader ? `Bearer ${expectedInstallationTokenInHeader}` : /^Bearer .+$/)
			.matchHeader("Accept", "application/vnd.github.v3+json")
			.reply(200, [
				{ number: 1 } // we don't really care about the shape of this response because it's in GitHub's hands anyways
			]);
	}

	it("lists pull requests", async () => {

		const owner = "owner";
		const repo = "repo";
		const pageSize = 5;
		const page = 1;

		givenGitHubReturnsInstallationToken("installation token");
		givenGitHubReturnsPullrequests(owner, repo, pageSize, page, "installation token");

		const client = new GitHubClient(appTokenCache, installationTokenCache, githubInstallationId);
		const pullrequests = await client.getPullRequests(owner, repo, pageSize, page);

		expect(pullrequests).toBeTruthy();
		expect(githubNock.pendingMocks()).toEqual([]);
	});

});
