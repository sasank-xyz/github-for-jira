import Logger from "bunyan";
import { Octokit } from "@octokit/rest";
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from "axios";
import AppTokenHolder from "./app-token-holder";
import InstallationTokenCache from "./installation-token-cache";
import AuthToken from "./auth-token";
import { handleFailedRequest, instrumentFailedRequest, instrumentRequest, setRequestStartTime, setRequestTimeout } from "./github-client-interceptors";
import { metricHttpRequest } from "config/metric-names";
import { getLogger } from "config/logger";
import { urlParamsMiddleware } from "utils/axios/url-params-middleware";
import { InstallationId } from "./installation-id";
import {
	getBranchesQueryWithChangedFiles,
	getBranchesQueryWithoutChangedFiles,
	getBranchesResponse,
	getCommitsQueryWithChangedFiles,
	getCommitsQueryWithoutChangedFiles,
	getCommitsResponse,
	ViewerRepositoryCountQuery
} from "./github-queries";
import { GetPullRequestParams, GraphQlQueryResponse, PaginatedAxiosResponse } from "./github-client.types";
import { GithubClientGraphQLError, isChangedFilesError, RateLimitingError } from "./github-client-errors";

/**
 * A GitHub client that supports authentication as a GitHub app.
 *
 * @see https://docs.github.com/en/developers/apps/building-github-apps/authenticating-with-github-apps
 */
export class GitHubAppClient {
	private readonly axios: AxiosInstance;
	private readonly appTokenHolder: AppTokenHolder;
	private readonly installationTokenCache: InstallationTokenCache;
	private readonly githubInstallationId: InstallationId;
	private readonly logger: Logger;

	constructor(
		githubInstallationId: InstallationId,
		logger: Logger,
		appTokenHolder: AppTokenHolder = AppTokenHolder.getInstance()
	) {
		this.logger = logger || getLogger("github.app.client");

		this.axios = axios.create({
			baseURL: githubInstallationId.githubBaseUrl,
			transitional: {
				clarifyTimeoutError: true
			}
		});

		this.axios.interceptors.request.use(setRequestStartTime);
		this.axios.interceptors.request.use(setRequestTimeout);
		this.axios.interceptors.request.use(urlParamsMiddleware);
		this.axios.interceptors.response.use(
			undefined,
			handleFailedRequest(this.logger)
		);
		this.axios.interceptors.response.use(
			instrumentRequest(metricHttpRequest.github),
			instrumentFailedRequest(metricHttpRequest.github)
		);
		this.appTokenHolder = appTokenHolder;
		this.installationTokenCache = InstallationTokenCache.getInstance();
		this.githubInstallationId = githubInstallationId;
	}

	/**
	 * Use this config in a request to authenticate with the app token.
	 */
	private appAuthenticationHeaders(): Partial<AxiosRequestConfig> {
		const appToken = this.appTokenHolder.getAppToken(this.githubInstallationId);
		return {
			headers: {
				Accept: "application/vnd.github.v3+json",
				Authorization: `Bearer ${appToken.token}`
			}
		};
	}

	/**
	 * Use this config in a request to authenticate with an installation token for the githubInstallationId.
	 */
	private async installationAuthenticationHeaders(): Promise<Partial<AxiosRequestConfig>> {
		const installationToken = await this.installationTokenCache.getInstallationToken(
			this.githubInstallationId.installationId,
			() => this.createInstallationToken(this.githubInstallationId.installationId));
		return {
			headers: {
				Accept: "application/vnd.github.v3+json",
				Authorization: `Bearer ${installationToken.token}`
			}
		};
	}

	/**
	 * Calls the GitHub API in the name of the GitHub app to generate a token that in turn can be used to call the GitHub
	 * API in the name of an installation of that app (to access the users' data).
	 */
	private async createInstallationToken(githubInstallationId: number): Promise<AuthToken> {
		const response = await this.axios.post<Octokit.AppsCreateInstallationTokenResponse>(`/app/installations/{githubInstallationId}/access_tokens`, {}, {
			...this.appAuthenticationHeaders(),
			urlParams: {
				githubInstallationId
			}
		});
		const tokenResponse: Octokit.AppsCreateInstallationTokenResponse = response.data;
		return new AuthToken(tokenResponse.token, new Date(tokenResponse.expires_at));
	}

	private async get<T>(url, params = {}, urlParams = {}): Promise<AxiosResponse<T>> {
		return this.axios.get<T>(url, {
			...await this.installationAuthenticationHeaders(),
			params,
			urlParams
		});
	}

	private async patch<T>(url, body = {}, params = {}, urlParams = {}): Promise<AxiosResponse<T>> {
		return this.axios.patch<T>(url, body, {
			...await this.installationAuthenticationHeaders(),
			params,
			urlParams
		});
	}

	private async graphql<T>(query: string, variables?: Record<string, string | number | undefined>): Promise<AxiosResponse<GraphQlQueryResponse<T>>> {
		const response = await this.axios.post<GraphQlQueryResponse<T>>("/graphql",
			{
				query,
				variables
			},
			{
				...await this.installationAuthenticationHeaders()
			});

		const graphqlErrors = response.data.errors;
		if (graphqlErrors?.length) {
			if (graphqlErrors.find(err => err.type == "RATE_LIMITED")) {
				return Promise.reject(new RateLimitingError(response));
			}

			const graphQlErrorMessage = graphqlErrors[0].message + (graphqlErrors.length > 1 ? ` and ${graphqlErrors.length - 1} more errors` : "");
			return Promise.reject(new GithubClientGraphQLError(graphQlErrorMessage, graphqlErrors));
		}

		return response;
	}

	/**
	 * Lists pull requests for the given repository.
	 */
	public async getPullRequests(owner: string, repo: string, pullRequestParams: GetPullRequestParams): Promise<AxiosResponse<Octokit.PullsListResponseItem[]>> {
		return await this.get<Octokit.PullsListResponseItem[]>(`/repos/{owner}/{repo}/pulls`, pullRequestParams, {
			owner,
			repo
		});
	}

	/**
	 * Get a single pull request for the given repository.
	 */
	// TODO: add a unit test
	public async getPullRequest(owner: string, repo: string, pullNumber: string | number): Promise<AxiosResponse<Octokit.PullsGetResponse>> {
		return await this.get<Octokit.PullsGetResponse>(`/repos/{owner}/{repo}/pulls/{pullNumber}`, {}, {
			owner,
			repo,
			pullNumber
		});
	}

	/**
	 * Get all reviews for a specific pull request.
	 */
	public async getPullRequestReviews(owner: string, repo: string, pullNumber: string | number): Promise<AxiosResponse<Octokit.PullsListReviewsResponse>> {
		return await this.get<Octokit.PullsListReviewsResponse>(`/repos/{owner}/{repo}/pulls/{pullNumber}/reviews`, {}, {
			owner,
			repo,
			pullNumber
		});
	}

	/**
	 * Get publicly available information for user with given username.
	 */
	// TODO: add a unit test
	public getUserByUsername = async (username: string): Promise<AxiosResponse<Octokit.UsersGetByUsernameResponse>> => {
		return await this.get<Octokit.UsersGetByUsernameResponse>(`/users/{username}`, {}, {
			username
		});
	};

	/**
	 * Get a single commit for the given repository.
	 */
	public getCommit = async (owner: string, repo: string, ref: string): Promise<AxiosResponse<Octokit.ReposGetCommitResponse>> => {
		return await this.get<Octokit.ReposGetCommitResponse>(`/repos/{owner}/{repo}/commits/{ref}`, {}, {
			owner,
			repo,
			ref
		});
	};

	public compareReferences = async (owner: string, repo: string, baseRef: string, headRef: string): Promise<AxiosResponse<Octokit.ReposCompareCommitsResponse>> => {
		return this.get<Octokit.ReposCompareCommitsResponse>(
			`/repos/{owner}/{repo}/compare/{basehead}`,
			undefined,
			{
				owner,
				repo,
				basehead: `${baseRef}...${headRef}`
			});
	};

	/**
	 * Returns a single reference from Git. The {ref} in the URL must be formatted as heads/<branch name>
	 */
	public getRef = async (owner: string, repo: string, ref: string): Promise<AxiosResponse<Octokit.GitGetRefResponse>> => {
		return await this.get<Octokit.GitGetRefResponse>(`/repos/{owner}/{repo}/git/ref/{ref}`, {}, {
			owner,
			repo,
			ref
		});
	};

	/**
	 * Get a page of repositories.
	 */
	public getRepositoriesPage = async (page = 1): Promise<PaginatedAxiosResponse<Octokit.AppsListReposResponse>> => {
		const response = await this.get<Octokit.AppsListReposResponse>(`/installation/repositories?per_page={perPage}&page={page}`, {}, {
			perPage: 100,
			page
		});
		const hasNextPage = !!response?.headers.link?.includes("rel=\"next\"");
		return {
			...response,
			hasNextPage
		};
	};

	public getInstallation = async (installationId: number): Promise<AxiosResponse<Octokit.AppsGetInstallationResponse>> => {
		return await this.axios.get<Octokit.AppsGetInstallationResponse>(`/app/installations/{installationId}`, {
			...this.appAuthenticationHeaders(),
			urlParams: {
				installationId
			}
		});
	};

	public listDeployments = async (owner: string, repo: string, environment: string, per_page: number): Promise<AxiosResponse<Octokit.ReposListDeploymentsResponse>> => {
		return await this.get<Octokit.ReposListDeploymentsResponse>(`/repos/{owner}/{repo}/deployments`,
			{ environment, per_page },
			{ owner, repo }
		);
	};

	public listDeploymentStatuses = async (owner: string, repo: string, deployment_id: number, per_page: number): Promise<AxiosResponse<Octokit.ReposListDeploymentStatusesResponse>> => {
		return await this.get<Octokit.ReposListDeploymentStatusesResponse>(`/repos/{owner}/{repo}/deployments/{deployment_id}/statuses`,
			{ per_page },
			{ owner, repo, deployment_id }
		);
	};

	public async updateIssue({ owner, repo, issue_number, body }: Octokit.IssuesUpdateParams): Promise<AxiosResponse<Octokit.IssuesUpdateResponse>> {
		return await this.patch<Octokit.IssuesUpdateResponse>(`/repos/{owner}/{repo}/issues/{issue_number}`, { body }, {},
			{
				owner,
				repo,
				issue_number
			});
	}

	public async getNumberOfReposForInstallation(): Promise<number> {
		const response = await this.graphql<{ viewer: { repositories: { totalCount: number } } }>(ViewerRepositoryCountQuery);

		return response?.data?.data?.viewer?.repositories?.totalCount;
	}

	public async getBranchesPage(owner: string, repoName: string, perPage: number, cursor?: string): Promise<getBranchesResponse> {
		const response = await this.graphql<getBranchesResponse>(getBranchesQueryWithChangedFiles,
			{
				owner,
				repo: repoName,
				per_page: perPage,
				cursor
			}).catch((err) => {
			// Is it a changedFiles error?
			if (!isChangedFilesError(err)) {
				return Promise.reject(err);
			}

			this.logger.warn("retrying branch graphql query without changedFiles");
			return this.graphql<getBranchesResponse>(getBranchesQueryWithoutChangedFiles,
				{
					owner,
					repo: repoName,
					per_page: perPage,
					cursor
				});
		});
		return response?.data?.data;
	}

	/**
	 * Attempt to get the commits page, if failing try again omiting the changedFiles field
	 */
	public async getCommitsPage(owner: string, repoName: string, perPage?: number, cursor?: string | number): Promise<getCommitsResponse> {
		const response = await this.graphql<getCommitsResponse>(getCommitsQueryWithChangedFiles,
			{
				owner,
				repo: repoName,
				per_page: perPage,
				cursor
			}).catch((err) => {

			if (!isChangedFilesError(err)) {
				return Promise.reject(err);
			}
			this.logger.warn("retrying commit graphql query without changedFiles");
			return this.graphql<getCommitsResponse>(getCommitsQueryWithoutChangedFiles,
				{
					owner,
					repo: repoName,
					per_page: perPage,
					cursor
				});
		});
		return response?.data?.data;
	}

	public async updateIssueComment({ owner, repo, comment_id, body }: Octokit.IssuesUpdateCommentParams): Promise<AxiosResponse<Octokit.IssuesUpdateCommentResponse>> {
		return await this.patch<Octokit.IssuesUpdateResponse>(
			`/repos/{owner}/{repo}/issues/comments/{comment_id}`,
			{ body },
			{},
			{
				owner,
				repo,
				comment_id
			});
	}
}