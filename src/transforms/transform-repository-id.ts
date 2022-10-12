import { GITHUB_CLOUD_BASEURL } from "utils/get-github-client-config";
import { booleanFlag, BooleanFlags } from "config/feature-flags";
import { getLogger } from "config/logger";

declare const transformedRepositoryId: unique symbol;

export type TransformedRepositoryId = string & { [transformedRepositoryId]: never };

function calculatePrefix(url: string) {
	const parsedUrl = new URL(url);

	// - "1024" is the limit for repo id in Jira API, see
	// https://developer.atlassian.com/cloud/jira/software/rest/api-group-development-information/#api-group-development-information ,
	// therefore limiting to 512 (half of the limit).
	// - Not base64 to avoid handling of special symbols (+/=) that are not allowed in Jira API.
	// - Not "hostname", but "host" in case different ports serving different GHES
	// - Including "pathname" in case there's a reverse-proxy that does routing to different GHES based on path
	// - Removing special characters to smooth quirks like "myserver.com/blah/" and "myserver.com/blah"
	// - Using parsed url to remove protocol (in case the server available via both HTTP and HTTPS) and query params
	const prefix = Buffer.from(
		(parsedUrl.host + parsedUrl.pathname).toLowerCase().replace(/[\W_]/g, '')
	).toString('hex').substring(0, 512);

	return prefix;
}

/**
 * @param repositoryId
 * @param gitHubBaseUrl - can be undefined for Cloud
 */
export async function transformRepositoryId(repositoryId: number, gitHubBaseUrl?: string): Promise<TransformedRepositoryId> {
	if (!await booleanFlag(BooleanFlags.USE_REPO_ID_TRANSFORMER, false)) {
		return ("" + repositoryId) as TransformedRepositoryId;
	}

	if (!gitHubBaseUrl || calculatePrefix(gitHubBaseUrl) === calculatePrefix(GITHUB_CLOUD_BASEURL)) {
		getLogger('bgvozdev-testing').info("Not prefixing");
		return ("" + repositoryId) as TransformedRepositoryId;
	}

	getLogger('bgvozdev-testing').info("Do prefix");

	return `${calculatePrefix(gitHubBaseUrl)}-${repositoryId}` as TransformedRepositoryId;
}
