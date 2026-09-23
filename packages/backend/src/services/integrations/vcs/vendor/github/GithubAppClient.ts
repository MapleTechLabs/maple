import { GitCommitSha } from "@maple/domain/http"
import { Clock, Context, Duration, Effect, Layer, Option, Redacted, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { GithubHttp } from "./GithubHttp"
import { githubWebBaseUrl } from "./github-hosts"

// GitHub App REST client. Vendor-specific: mints a short-lived App JWT (RS256,
// Web Crypto), exchanges it for per-installation tokens, and calls the GitHub
// REST API. No Octokit (Worker bundle weight). This module never touches the application database.
//
// `GithubAppError` is internal to the GitHub layer; `GithubProvider` maps it to
// the generic `VcsProviderError` at the port boundary.

export class GithubAppError extends Schema.TaggedError<GithubAppError>()("@maple/api/vcs/GithubAppError", {
	message: Schema.String,
	status: Schema.optionalKey(Schema.Number),
	// Which resource the failing call addressed, so the provider can tell an
	// installation-auth failure (the gone/suspended signal) from a repo-level one.
	scope: Schema.optionalKey(Schema.Literals(["installation", "repository"])),
	// Set when the failure is a rate limit too far out to wait through inline:
	// seconds until the budget returns. The provider maps this to VcsRateLimitedError.
	retryAfterSeconds: Schema.optionalKey(Schema.Number),
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

const GITHUB_API_VERSION = "2022-11-28"
const USER_AGENT = "maple-vcs-integration"
const PER_PAGE = 100
// Paginate effectively to the end (up to 100k items) while still bounding a
// pathological loop. Hitting this cap is logged — truncation is never silent.
const MAX_PAGES = 1000
/** GitHub lists at most 3,000 files for one pull request. */
const MAX_PR_FILE_PAGES = 30
// Pages walked per consumer invocation before yielding a continuation. Caps
// wall-clock per invocation to stay under Cloudflare Queues' 15-min limit;
// the remainder resumes from a committer-date watermark in a follow-up job.
export const COMMIT_PAGES_PER_INVOCATION = 25
// Ride out short rate limits inline; anything longer is surfaced so the caller
// can defer (backfill requeues from a cursor; other jobs get a delayed retry).
const INLINE_BACKOFF_CAP_S = 30
// Cap inline rate-limit retries so a server stuck reporting tiny/zero waits (e.g.
// a past reset timestamp from clock skew) can't spin the consumer forever; once
// hit, we defer like any other long wait rather than looping.
const MAX_INLINE_RATE_LIMIT_RETRIES = 5
// Retire a cached token this early so it never expires mid-request. Tokens last
// ~1h, so the extra minute just costs an occasional re-mint.
const INSTALLATION_TOKEN_EXPIRY_SKEW_MS = 60_000

// A GitHub rate-limit response is a 429, or a 403 that carries `retry-after` /
// reports zero remaining (the secondary-limit shape). Plain 403s (permissions)
// are NOT rate limits.
const isRateLimited = (response: Response): boolean =>
	response.status === 429 ||
	(response.status === 403 &&
		(response.headers.get("retry-after") !== null ||
			response.headers.get("x-ratelimit-remaining") === "0"))

// Seconds until the budget returns, per GitHub's guidance: prefer `retry-after`,
// else wait until the rate-limit reset (epoch seconds), else a conservative minute.
const rateLimitWaitSeconds = (response: Response, nowMs: number): number => {
	const retryAfter = response.headers.get("retry-after")
	if (retryAfter !== null) {
		const secs = Number(retryAfter)
		if (Number.isFinite(secs) && secs >= 0) return secs
		// `retry-after` may be an HTTP-date instead of delta-seconds.
		const dateMs = Date.parse(retryAfter)
		if (Number.isFinite(dateMs)) return Math.max(0, Math.ceil((dateMs - nowMs) / 1000))
	}
	const reset = response.headers.get("x-ratelimit-reset")
	if (reset !== null) {
		const resetSec = Number(reset)
		if (Number.isFinite(resetSec)) return Math.max(0, Math.ceil(resetSec - nowMs / 1000))
	}
	return 60
}

const GithubInstallationTokenResponse = Schema.Struct({
	token: Schema.String,
	expires_at: Schema.String,
})

// `GET /app/installations/{id}` (App-JWT auth): the installed account + which
// repositories the installation can see. Used by the dashboard connect flow to
// populate the installation row without needing a user OAuth token.
const GithubInstallationDetailSchema = Schema.Struct({
	id: Schema.Number,
	account: Schema.NullOr(
		Schema.Struct({
			login: Schema.String,
			id: Schema.Number,
			type: Schema.String, // "User" | "Organization"
			avatar_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	repository_selection: Schema.optionalKey(Schema.String), // "all" | "selected"
})

// Response from the OAuth token exchange. GitHub returns either `access_token` or,
// even on a 200, an `error` field — so both are optional and we check which we got.
const GithubOAuthTokenResponse = Schema.Struct({
	access_token: Schema.optionalKey(Schema.String),
	token_type: Schema.optionalKey(Schema.String),
	scope: Schema.optionalKey(Schema.String),
	error: Schema.optionalKey(Schema.String),
	error_description: Schema.optionalKey(Schema.String),
})

// `GET /user/installations` — the installations this user can manage. We use it to
// confirm they actually own the one they're connecting.
const GithubUserInstallationsResponse = Schema.Struct({
	total_count: Schema.Number,
	installations: Schema.Array(Schema.Struct({ id: Schema.Number })),
})

const GithubApiRepoSchema = Schema.Struct({
	id: Schema.Number,
	name: Schema.String,
	full_name: Schema.String,
	private: Schema.Boolean,
	archived: Schema.optionalKey(Schema.Boolean),
	default_branch: Schema.optionalKey(Schema.String),
	html_url: Schema.String,
	owner: Schema.Struct({ login: Schema.String }),
})
type GithubApiRepo = Schema.Schema.Type<typeof GithubApiRepoSchema>

const GithubInstallationReposResponse = Schema.Struct({
	total_count: Schema.Number,
	repositories: Schema.Array(GithubApiRepoSchema),
})

const GithubApiCommitAuthor = Schema.Struct({
	name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	email: Schema.optionalKey(Schema.NullOr(Schema.String)),
	date: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

const GithubApiUser = Schema.Struct({
	login: Schema.String,
	avatar_url: Schema.optionalKey(Schema.String),
})

const GithubApiCommitSchema = Schema.Struct({
	sha: GitCommitSha, // validated at decode — the 40-hex shape lives in the brand
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.NullOr(GithubApiCommitAuthor),
		committer: Schema.optionalKey(Schema.NullOr(GithubApiCommitAuthor)),
	}),
	author: Schema.NullOr(GithubApiUser),
})
export type GithubApiCommit = Schema.Schema.Type<typeof GithubApiCommitSchema>

const GithubApiCommitList = Schema.Array(GithubApiCommitSchema)

const GithubApiBranchSchema = Schema.Struct({
	name: Schema.String,
	commit: Schema.Struct({ sha: GitCommitSha }), // 40-hex validated by the brand
})
type GithubApiBranch = Schema.Schema.Type<typeof GithubApiBranchSchema>
const GithubApiBranchList = Schema.Array(GithubApiBranchSchema)

// A pull request as the REST API reports it, list and detail alike (the detail
// payload is a superset). `merged_at` — not `state` — is what distinguishes a
// merged PR from one closed unmerged; `state` alone only ever says open/closed.
const GithubApiPullRequestSchema = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	html_url: Schema.String,
	state: Schema.String,
	draft: Schema.optionalKey(Schema.Boolean),
	updated_at: Schema.String,
	merged_at: Schema.NullOr(Schema.String),
	merge_commit_sha: Schema.NullOr(Schema.String),
	user: Schema.NullOr(GithubApiUser),
	head: Schema.Struct({ ref: Schema.String }),
	base: Schema.Struct({ ref: Schema.String }),
})
export type GithubApiPullRequest = Schema.Schema.Type<typeof GithubApiPullRequestSchema>
const GithubApiPullRequestList = Schema.Array(GithubApiPullRequestSchema)

// One file of a pull request's diff. `patch` is absent for binary files and for
// files GitHub judges too large to inline; the caller reads those another way.
const GithubApiPullRequestFileSchema = Schema.Struct({
	filename: Schema.String,
	previous_filename: Schema.optionalKey(Schema.String),
	status: Schema.String,
	additions: Schema.Number,
	deletions: Schema.Number,
	patch: Schema.optionalKey(Schema.String),
})
export type GithubApiPullRequestFile = Schema.Schema.Type<typeof GithubApiPullRequestFileSchema>
const GithubApiPullRequestFileList = Schema.Array(GithubApiPullRequestFileSchema)

const GithubApiPullRequestCommitList = Schema.Array(
	Schema.Struct({ sha: Schema.String, commit: Schema.Struct({ message: Schema.String }) }),
)
const GithubApiDiscussionCommentList = Schema.Array(
	Schema.Struct({
		user: Schema.NullOr(GithubApiUser),
		body: Schema.optionalKey(Schema.NullOr(Schema.String)),
		path: Schema.optionalKey(Schema.String),
		line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		performed_via_github_app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
	}),
)
const GithubApiCheckRunList = Schema.Struct({
	check_runs: Schema.Array(
		Schema.Struct({
			name: Schema.String,
			status: Schema.String,
			conclusion: Schema.NullOr(Schema.String),
			output: Schema.optionalKey(Schema.Struct({ title: Schema.NullOr(Schema.String) })),
		}),
	),
})
const GithubApiPullRequestHead = Schema.Struct({
	number: Schema.Number,
	title: Schema.String,
	html_url: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	user: Schema.NullOr(GithubApiUser),
	state: Schema.String,
	draft: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
	head: Schema.Struct({
		sha: Schema.String,
		ref: Schema.String,
		repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
	}),
	base: Schema.Struct({ sha: Schema.String, ref: Schema.String }),
})
export type GithubApiPullRequestHead = Schema.Schema.Type<typeof GithubApiPullRequestHead>
const GithubApiCreatedComment = Schema.Struct({ id: Schema.Number, html_url: Schema.String })
const GithubApiCollaboratorPermission = Schema.Struct({ permission: Schema.String })
const GithubApiGitCommit = Schema.Struct({
	sha: Schema.String,
	html_url: Schema.optionalKey(Schema.String),
	tree: Schema.Struct({ sha: Schema.String }),
})
const GithubApiGitTree = Schema.Struct({ sha: Schema.String })

const GithubApiReviewCommentList = Schema.Array(
	Schema.Struct({
		id: Schema.Number,
		path: Schema.String,
		line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		original_line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	}),
)
const GithubApiComparison = Schema.Struct({
	files: Schema.optionalKey(Schema.Array(Schema.Struct({ filename: Schema.String }))),
})
const GithubGraphqlErrors = Schema.optionalKey(
	Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.String }))),
)
const GithubReviewThreadsResponse = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				repository: Schema.NullOr(
					Schema.Struct({
						pullRequest: Schema.NullOr(
							Schema.Struct({
								reviewThreads: Schema.Struct({
									nodes: Schema.Array(
										Schema.Struct({
											id: Schema.String,
											isResolved: Schema.Boolean,
											comments: Schema.Struct({
												nodes: Schema.Array(
													Schema.Struct({
														databaseId: Schema.NullOr(Schema.Number),
														author: Schema.NullOr(
															Schema.Struct({ login: Schema.String }),
														),
														body: Schema.String,
													}),
												),
											}),
										}),
									),
								}),
							}),
						),
					}),
				),
			}),
		),
	),
	errors: GithubGraphqlErrors,
})
const GithubMutationResponse = Schema.Struct({ errors: GithubGraphqlErrors })
export type GithubReviewThread = NonNullable<
	NonNullable<
		NonNullable<Schema.Schema.Type<typeof GithubReviewThreadsResponse>["data"]>["repository"]
	>["pullRequest"]
>["reviewThreads"]["nodes"][number]

export type GithubApiDiscussionComment = Schema.Schema.Type<typeof GithubApiDiscussionCommentList>[number]

const GithubApiCheckRunSchema = Schema.Struct({
	id: Schema.Number,
	html_url: Schema.NullOr(Schema.String),
})
const GithubApiIssueCommentSchema = Schema.Struct({
	id: Schema.Number,
	html_url: Schema.String,
	body: Schema.optionalKey(Schema.NullOr(Schema.String)),
	performed_via_github_app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
})
const GithubApiIssueCommentList = Schema.Array(GithubApiIssueCommentSchema)

/** Pages of issue comments searched for the review's own summary comment before posting a new one. */
const MAX_COMMENT_PAGES = 10

const GithubApiReviewSchema = Schema.Struct({
	id: Schema.Number,
	html_url: Schema.optionalKey(Schema.NullOr(Schema.String)),
})

/** GitHub accepts at most this many annotations per check-run request. */
export const CHECK_RUN_ANNOTATION_LIMIT = 50

export interface GithubCheckRunInput {
	readonly name: string
	readonly headSha: string
	readonly conclusion: "success" | "neutral"
	readonly title: string
	readonly summary: string
	readonly annotations: ReadonlyArray<{
		readonly path: string
		readonly startLine: number
		readonly endLine: number
		readonly level: "notice" | "warning" | "failure"
		readonly title: string
		readonly message: string
	}>
}

export interface GithubReviewInput {
	readonly commitId: string
	readonly body: string
	readonly comments: ReadonlyArray<{
		readonly path: string
		readonly line: number
		readonly startLine?: number
		readonly body: string
	}>
}

const GithubCodeSearchResponseSchema = Schema.Struct({
	items: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			sha: Schema.String,
			html_url: Schema.String,
			text_matches: Schema.optionalKey(
				Schema.Array(
					Schema.Struct({
						fragment: Schema.String,
					}),
				),
			),
		}),
	),
})

const GithubContentFileSchema = Schema.Struct({
	type: Schema.Literal("file"),
	path: Schema.String,
	sha: Schema.String,
	size: Schema.Number,
	html_url: Schema.NullOr(Schema.String),
	encoding: Schema.String,
	content: Schema.String,
})

const decodeOAuthToken = Schema.decodeUnknownEffect(GithubOAuthTokenResponse)
const decodeUserInstallations = Schema.decodeUnknownEffect(GithubUserInstallationsResponse)
const decodeInstallationToken = Schema.decodeUnknownEffect(GithubInstallationTokenResponse)
const decodeInstallationDetail = Schema.decodeUnknownEffect(GithubInstallationDetailSchema)
const decodeInstallationRepos = Schema.decodeUnknownEffect(GithubInstallationReposResponse)
const decodeCommitList = Schema.decodeUnknownEffect(GithubApiCommitList)
const decodeCommit = Schema.decodeUnknownEffect(GithubApiCommitSchema)
const decodeBranchList = Schema.decodeUnknownEffect(GithubApiBranchList)
const decodePullRequestList = Schema.decodeUnknownEffect(GithubApiPullRequestList)
const decodePullRequest = Schema.decodeUnknownEffect(GithubApiPullRequestSchema)
const decodePullRequestFiles = Schema.decodeUnknownEffect(GithubApiPullRequestFileList)
const decodeCheckRun = Schema.decodeUnknownEffect(GithubApiCheckRunSchema)
const decodePullRequestCommits = Schema.decodeUnknownEffect(GithubApiPullRequestCommitList)
const decodeDiscussionComments = Schema.decodeUnknownEffect(GithubApiDiscussionCommentList)
const decodeCheckRunList = Schema.decodeUnknownEffect(GithubApiCheckRunList)
const decodeReviewCommentList = Schema.decodeUnknownEffect(GithubApiReviewCommentList)
const decodePullRequestHead = Schema.decodeUnknownEffect(GithubApiPullRequestHead)
const decodeCreatedComment = Schema.decodeUnknownEffect(GithubApiCreatedComment)
const decodeCollaboratorPermission = Schema.decodeUnknownEffect(GithubApiCollaboratorPermission)
const decodeGitCommit = Schema.decodeUnknownEffect(GithubApiGitCommit)
const decodeComparison = Schema.decodeUnknownEffect(GithubApiComparison)
const decodeReviewThreads = Schema.decodeUnknownEffect(GithubReviewThreadsResponse)
const decodeMutation = Schema.decodeUnknownEffect(GithubMutationResponse)

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes { id isResolved comments(first: 20) { nodes { databaseId author { login } body } } }
      }
    }
  }
}`
const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`

/** GitHub.com serves GraphQL at `/graphql`; Enterprise at `/api/graphql` beside `/api/v3`. */
const graphqlUrl = (apiBaseUrl: string) =>
	apiBaseUrl.endsWith("/api/v3") ? `${apiBaseUrl.slice(0, -"/v3".length)}/graphql` : `${apiBaseUrl}/graphql`
const decodeReview = Schema.decodeUnknownEffect(GithubApiReviewSchema)
const decodeIssueComment = Schema.decodeUnknownEffect(GithubApiIssueCommentSchema)
const decodeIssueCommentList = Schema.decodeUnknownEffect(GithubApiIssueCommentList)
const decodeCodeSearch = Schema.decodeUnknownEffect(GithubCodeSearchResponseSchema)
const decodeContentFile = Schema.decodeUnknownEffect(GithubContentFileSchema)

const base64UrlString = (value: string) => Buffer.from(value, "utf8").toString("base64url")
const base64UrlBytes = (value: ArrayBuffer) => Buffer.from(value).toString("base64url")

const pemToPkcs8 = (pem: string): ArrayBuffer => {
	const body = pem
		.replace(/-----BEGIN[^-]+-----/g, "")
		.replace(/-----END[^-]+-----/g, "")
		.replace(/\s+/g, "")
	const buf = Buffer.from(body, "base64")
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}

interface ResolvedAppConfig {
	readonly appId: string
	readonly privateKeyPem: string
	readonly apiBaseUrl: string
}

export class GithubAppClient extends Context.Service<GithubAppClient>()(
	"@maple/api/services/vcs/vendor/github/GithubAppClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const http = yield* GithubHttp

			// Reuse one token per installation instead of minting a fresh one per repo.
			// Tokens last ~1h; cache is per-isolate (externalInstallationId → token + expiry).
			const installationTokens = new Map<string, { token: string; expiresAtMs: number }>()

			// Every GitHub REST call goes through here so the dependency is a real
			// Client-kind span: `peer.service` is what draws the GitHub node/edge on
			// the service map, and the HTTP attributes make an upstream 5xx or a
			// throttle attributable without reading logs.
			//
			// `url.path` (not `url.full`) on purpose — the query carries pagination
			// but also `search/code?q=…`, i.e. the caller's raw search text, which has
			// no business in telemetry. Tokens travel in headers, never the URL.
			const tracedFetch = Effect.fn("GithubAppClient.request", {
				kind: "client",
				attributes: { "peer.service": "github" },
			})(function* (url: string, init: RequestInit | undefined, errorMessage: string) {
				const parsed = Option.liftThrowable(() => new URL(url))()
				yield* Effect.annotateCurrentSpan({
					"http.request.method": init?.method ?? "GET",
					...(Option.isSome(parsed)
						? {
								"server.address": parsed.value.host,
								"url.path": parsed.value.pathname,
							}
						: undefined),
				})
				const response = yield* Effect.tryPromise({
					try: () => http.fetch(url, init),
					catch: (cause) => new GithubAppError({ message: errorMessage, cause }),
				})
				yield* Effect.annotateCurrentSpan({ "http.response.status_code": response.status })
				return response
			})

			// Run a request, riding out short rate limits inline and surfacing longer
			// ones as a GithubAppError carrying `retryAfterSeconds`.
			const rateLimitedFetch = (request: Effect.Effect<Response, GithubAppError>) =>
				Effect.gen(function* () {
					let inlineRetries = 0
					while (true) {
						const response = yield* request
						if (!isRateLimited(response)) return response
						const waitS = rateLimitWaitSeconds(response, yield* Clock.currentTimeMillis)
						// Defer (surface to the caller) when a single wait is longer than we'll
						// ride out inline, OR when we've retried inline too many times. Floor
						// the exhausted-case deferral so a tiny/zero-wait server can't drive an
						// immediate-redelivery loop after we stop spinning.
						const exhausted = inlineRetries >= MAX_INLINE_RATE_LIMIT_RETRIES
						if (waitS > INLINE_BACKOFF_CAP_S || exhausted) {
							return yield* new GithubAppError({
								message: `GitHub rate limited (retry after ${waitS}s)`,
								status: response.status,
								retryAfterSeconds: exhausted ? Math.max(waitS, 60) : waitS,
							})
						}
						inlineRetries += 1
						// Surface the inline-wait on the active HTTP span so a slow GitHub call
						// is attributable to throttling (not network latency) from the trace.
						yield* Effect.annotateCurrentSpan({
							"vcs.provider.rate_limited": true,
							"vcs.provider.rate_limit_wait_s": waitS,
						})
						yield* Effect.logWarning("[GitHub] Rate limit hit — waiting inline").pipe(
							Effect.annotateLogs({
								waitSeconds: waitS,
								status: response.status,
								attempt: inlineRetries,
							}),
						)
						yield* Effect.sleep(Duration.seconds(waitS))
					}
				})

			const resolveConfig: Effect.Effect<ResolvedAppConfig, GithubAppError> = Effect.gen(function* () {
				const appId = Option.getOrUndefined(env.GITHUB_APP_ID)
				const privateKey = Option.getOrUndefined(env.GITHUB_APP_PRIVATE_KEY)
				if (!appId || !privateKey) {
					return yield* new GithubAppError({
						message:
							"GitHub App is not configured (set GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
					})
				}
				return {
					appId,
					privateKeyPem: Redacted.value(privateKey),
					apiBaseUrl: env.GITHUB_API_BASE_URL.replace(/\/+$/, ""),
				}
			})

			const importSigningKey = (pem: string) =>
				Effect.tryPromise({
					try: () =>
						crypto.subtle.importKey(
							"pkcs8",
							pemToPkcs8(pem),
							{ name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
							false,
							["sign"],
						),
					catch: (cause) =>
						new GithubAppError({ message: "Failed to import GitHub App private key", cause }),
				})

			const mintAppJwt = Effect.fn("GithubAppClient.mintAppJwt")(function* (config: ResolvedAppConfig) {
				const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const header = base64UrlString(JSON.stringify({ alg: "RS256", typ: "JWT" }))
				// iat back-dated 60s for clock skew; exp ≤ 10min per GitHub's limit.
				const payload = base64UrlString(
					JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: config.appId }),
				)
				const signingInput = `${header}.${payload}`
				const key = yield* importSigningKey(config.privateKeyPem)
				const signature = yield* Effect.tryPromise({
					try: () =>
						crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(signingInput)),
					catch: (cause) => new GithubAppError({ message: "JWT signing failed", cause }),
				})
				return `${signingInput}.${base64UrlBytes(signature)}`
			})

			const failure = (response: Response, context: string, scope?: "installation" | "repository") =>
				Effect.gen(function* () {
					const body = yield* Effect.tryPromise({
						try: () => response.text(),
						catch: () =>
							new GithubAppError({
								message: `${context} failed`,
								status: response.status,
								scope,
							}),
					})
					return yield* Effect.fail(
						new GithubAppError({
							message: `${context} failed: ${response.status} ${body.slice(0, 300)}`,
							status: response.status,
							scope,
						}),
					)
				})

			const parseJson = (response: Response, context: string) =>
				Effect.tryPromise({
					try: () => response.json() as Promise<unknown>,
					catch: (cause) =>
						new GithubAppError({ message: `${context} returned a non-JSON response`, cause }),
				})

			const mintInstallationToken = Effect.fn("GithubAppClient.mintInstallationToken")(function* (
				externalInstallationId: string,
			) {
				// Return a cached token if it's still good, so we don't re-mint per repo.
				const now = yield* Clock.currentTimeMillis
				const cached = installationTokens.get(externalInstallationId)
				if (cached !== undefined && cached.expiresAtMs - INSTALLATION_TOKEN_EXPIRY_SKEW_MS > now) {
					yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "hit" })
					return cached.token
				}
				yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "miss" })

				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* rateLimitedFetch(
					tracedFetch(
						`${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${jwt}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						},
						"Installation token request failed",
					),
				)
				// A non-rate-limit failure here is the installation auth gate — the
				// authoritative "installation gone / suspended" signal (rate limits were
				// already split off by rateLimitedFetch above).
				if (!response.ok)
					return yield* failure(response, "Installation token request", "installation")
				const json = yield* parseJson(response, "Installation token request")
				const decoded = yield* decodeInstallationToken(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected installation token payload", cause }),
					),
				)
				// Cache it. If we can't read the expiry, skip caching rather than risk
				// reusing a token forever.
				const expiresAtMs = Date.parse(decoded.expires_at)
				if (Number.isFinite(expiresAtMs)) {
					installationTokens.set(externalInstallationId, { token: decoded.token, expiresAtMs })
				}
				return decoded.token
			})

			const authedGet = (_config: ResolvedAppConfig, token: string, url: string) =>
				rateLimitedFetch(
					tracedFetch(
						url,
						{
							headers: {
								authorization: `token ${token}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						},
						`GitHub request failed: ${url}`,
					),
				)

			const listInstallationRepositories = Effect.fn("GithubAppClient.listInstallationRepositories")(
				function* (externalInstallationId: string) {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const repos: Array<GithubApiRepo> = []
					let page = 1
					for (; page <= MAX_PAGES; page++) {
						const response = yield* authedGet(
							config,
							token,
							`${config.apiBaseUrl}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!response.ok) return yield* failure(response, "List installation repositories")
						const json = yield* parseJson(response, "List installation repositories")
						const decoded = yield* decodeInstallationRepos(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({
										message: "Unexpected installation repositories payload",
										cause,
									}),
							),
						)
						repos.push(...decoded.repositories)
						if (decoded.repositories.length < PER_PAGE) break
					}
					// Exhausted the page cap without a short final page → likely truncated.
					if (page > MAX_PAGES) {
						yield* Effect.logWarning(
							"[GitHub] Installation repositories truncated at page cap",
						).pipe(
							Effect.annotateLogs({
								externalInstallationId,
								maxPages: MAX_PAGES,
								fetched: repos.length,
							}),
						)
					}
					return repos
				},
			)

			// Returns `truncated` when the page cap is hit so the caller can skip
			// delete-reconciliation. Scoped to "repository" so a 404 means "repo
			// unavailable", not "no branches".
			const listBranches = Effect.fn("GithubAppClient.listBranches")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches`
				const branches: Array<GithubApiBranch> = []
				let page = 1
				for (; page <= MAX_PAGES; page++) {
					const response = yield* authedGet(
						config,
						token,
						`${base}?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok) return yield* failure(response, "List branches", "repository")
					const json = yield* parseJson(response, "List branches")
					const decoded = yield* decodeBranchList(json).pipe(
						Effect.mapError(
							(cause) => new GithubAppError({ message: "Unexpected branches payload", cause }),
						),
					)
					branches.push(...decoded)
					if (decoded.length < PER_PAGE) break
				}
				const truncated = page > MAX_PAGES
				if (truncated) {
					yield* Effect.logWarning("[GitHub] Branches truncated at page cap").pipe(
						Effect.annotateLogs({ owner, repo, maxPages: MAX_PAGES, fetched: branches.length }),
					)
				}
				return { branches, truncated }
			})

			// Returns commits page-by-page until the window is exhausted OR the
			// per-invocation page budget is hit. Two ways a walk is cut short, both
			// reported as a *partial* result (commits kept, never refetched) so the
			// caller can checkpoint + requeue:
			//  - `"rate-limited"`: a rate limit too far out to ride inline (from the
			//    token mint OR any page), caught at the outer level.
			//  - `"page-budget"`: `COMMIT_PAGES_PER_INVOCATION` full pages fetched with
			//    more to come — yield so one invocation stays under the queue's limit.
			const listCommits = Effect.fn("GithubAppClient.listCommits")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				params: { sha?: string; sinceIso?: string; untilIso?: string },
			) {
				const commits: Array<GithubApiCommit> = []
				const outcome = yield* Effect.gen(function* () {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`
					for (let page = 1; page <= COMMIT_PAGES_PER_INVOCATION; page++) {
						const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })
						if (params.sha) query.set("sha", params.sha)
						if (params.sinceIso) query.set("since", params.sinceIso)
						if (params.untilIso) query.set("until", params.untilIso)
						const response = yield* authedGet(config, token, `${base}?${query.toString()}`)
						// 409 = empty repository → genuinely no commits, not an error.
						if (response.status === 409) return { complete: true as const }
						// Anything else non-2xx (incl. 404 = repo deleted / access lost) is
						// surfaced as a repository-scoped failure so the orchestrator can mark
						// the repo unavailable rather than mistaking it for an empty repo.
						if (!response.ok) return yield* failure(response, "List commits", "repository")
						const json = yield* parseJson(response, "List commits")
						const decoded = yield* decodeCommitList(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected commits payload", cause }),
							),
						)
						commits.push(...decoded)
						if (decoded.length < PER_PAGE) return { complete: true as const }
					}
					// Full final page with no break → more remain; yield a continuation.
					return { complete: false as const, reason: "page-budget" as const }
				}).pipe(
					Effect.catch((error) =>
						error.retryAfterSeconds === undefined
							? Effect.fail(error)
							: Effect.succeed({
									complete: false as const,
									reason: "rate-limited" as const,
									retryAfterSeconds: error.retryAfterSeconds,
								}),
					),
				)
				if (outcome.complete) return { commits, complete: true as const }
				return outcome.reason === "rate-limited"
					? {
							commits,
							complete: false as const,
							reason: "rate-limited" as const,
							retryAfterSeconds: outcome.retryAfterSeconds,
						}
					: { commits, complete: false as const, reason: "page-budget" as const }
			})

			// `sha` is any committish the caller names, not only a 40-hex sha — ref
			// resolution shares this call. It is encoded because an unencoded `..`
			// segment is normalised away by URL parsing, which would walk this
			// installation-wide token onto a repository the org never connected.
			const getCommit = Effect.fn("GithubAppClient.getCommit")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				sha: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(sha)}`,
				)
				if (!response.ok) return yield* failure(response, "Get commit", "repository")
				const json = yield* parseJson(response, "Get commit")
				return yield* decodeCommit(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected commit payload", cause }),
					),
				)
			})

			/**
			 * A clone credential for one repository: the plain remote, plus a token
			 * minted for that repository alone.
			 *
			 * Deliberately not `mintInstallationToken`: that token reaches every
			 * repository the installation can see and is cached for an hour, and this
			 * one travels into a container that also runs model-chosen commands. The
			 * `repositories` + `permissions` body narrows it to read-only contents on a
			 * single repository, and it is never cached. It is returned apart from the
			 * URL so nothing downstream is tempted to put it in a command's arguments.
			 */
			const mintCloneCredentials = Effect.fn("GithubAppClient.mintCloneCredentials")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
			) {
				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* rateLimitedFetch(
					tracedFetch(
						`${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`,
						{
							method: "POST",
							headers: {
								authorization: `Bearer ${jwt}`,
								accept: "application/vnd.github+json",
								"content-type": "application/json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
							body: JSON.stringify({
								repositories: [repo],
								permissions: { contents: "read", metadata: "read" },
							}),
						},
						"Scoped installation token request failed",
					),
				)
				if (!response.ok)
					return yield* failure(response, "Scoped installation token request", "installation")
				const json = yield* parseJson(response, "Scoped installation token request")
				const decoded = yield* decodeInstallationToken(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected installation token payload", cause }),
					),
				)
				const web = githubWebBaseUrl(config.apiBaseUrl)
				return {
					remoteUrl: `${web}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}.git`,
					token: decoded.token,
				}
			})

			// One page, newest-updated first — never a pagination walk. This feeds the
			// attach-a-PR picker, where the PR that fixes a live issue is recent by
			// construction, and a walk would spend an installation's rate budget on
			// history nobody is going to scroll to.
			//
			// Deliberately not `GET /search/issues`, which would allow server-side text
			// matching: its 30-req/min secondary limit is a poor fit for a keystroke-
			// driven picker. Filtering happens client-side over this page instead.
			const listPullRequests = Effect.fn("GithubAppClient.listPullRequests")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				limit: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const params = new URLSearchParams({
					state: "all",
					sort: "updated",
					direction: "desc",
					per_page: String(Math.min(limit, PER_PAGE)),
					page: "1",
				})
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?${params.toString()}`,
				)
				if (!response.ok) return yield* failure(response, "List pull requests", "repository")
				const json = yield* parseJson(response, "List pull requests")
				return yield* decodePullRequestList(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected pull requests payload", cause }),
					),
				)
			})

			// `null` on 404 — a PR number that does not exist in this repo is an
			// expected answer (someone mistyped, or pasted a URL for another repo),
			// not a provider failure. Every other non-2xx stays repository-scoped.
			const getPullRequest = Effect.fn("GithubAppClient.getPullRequest")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}`,
				)
				if (response.status === 404) return null
				if (!response.ok) return yield* failure(response, "Get pull request", "repository")
				const json = yield* parseJson(response, "Get pull request")
				return yield* decodePullRequest(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected pull request payload", cause }),
					),
				)
			})

			const authedSend = (
				method: "POST" | "PATCH",
				token: string,
				url: string,
				body: unknown,
				context: string,
			) =>
				rateLimitedFetch(
					tracedFetch(
						url,
						{
							method,
							headers: {
								authorization: `token ${token}`,
								accept: "application/vnd.github+json",
								"content-type": "application/json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
							body: JSON.stringify(body),
						},
						`${context} failed`,
					),
				)

			// Every page: a review needs the whole diff, and GitHub itself stops at
			// 3,000 files, which is PER_PAGE * MAX_PR_FILE_PAGES.
			const listPullRequestFiles = Effect.fn("GithubAppClient.listPullRequestFiles")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const files: Array<GithubApiPullRequestFile> = []
				for (let page = 1; page <= MAX_PR_FILE_PAGES; page++) {
					const response = yield* authedGet(
						config,
						token,
						`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok) return yield* failure(response, "List pull request files", "repository")
					const json = yield* parseJson(response, "List pull request files")
					const decoded = yield* decodePullRequestFiles(json).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({
									message: "Unexpected pull request files payload",
									cause,
								}),
						),
					)
					files.push(...decoded)
					if (decoded.length < PER_PAGE) break
				}
				return files
			})

			// One page of each: the reviewer wants the recent story, not the archive. Checks come
			// from the last commit, which is the head. The App's own comments are left out, so the
			// reviewer is never told to avoid repeating itself by its own summary.
			const getPullRequestContext = Effect.fn("GithubAppClient.getPullRequestContext")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
				const getJson = Effect.fnUntraced(function* (url: string, context: string) {
					const response = yield* authedGet(config, token, url)
					if (!response.ok) return yield* failure(response, context, "repository")
					return yield* parseJson(response, context)
				})
				const unexpected = (what: string) => (cause: unknown) =>
					new GithubAppError({ message: `Unexpected ${what} payload`, cause })
				const commits = yield* decodePullRequestCommits(
					yield* getJson(
						`${base}/pulls/${number}/commits?per_page=${PER_PAGE}`,
						"List pull request commits",
					),
				).pipe(Effect.mapError(unexpected("pull request commits")))
				const [inline, conversation] = yield* Effect.all(
					[
						getJson(
							`${base}/pulls/${number}/comments?per_page=${PER_PAGE}&sort=created&direction=desc`,
							"List review comments",
						),
						getJson(
							`${base}/issues/${number}/comments?per_page=${PER_PAGE}`,
							"List pull request comments",
						),
					],
					{ concurrency: 2 },
				)
				const notOwn = (comment: GithubApiDiscussionComment) =>
					String(comment.performed_via_github_app?.id ?? "") !== config.appId
				const comments = [
					...(yield* decodeDiscussionComments(inline).pipe(
						Effect.mapError(unexpected("review comments")),
					)),
					...(yield* decodeDiscussionComments(conversation).pipe(
						Effect.mapError(unexpected("comments")),
					)),
				].filter(notOwn)
				const head = commits.at(-1)?.sha
				const checks =
					head === undefined
						? []
						: (yield* decodeCheckRunList(
								yield* getJson(
									`${base}/commits/${head}/check-runs?per_page=${PER_PAGE}`,
									"List check runs",
								),
							).pipe(Effect.mapError(unexpected("check runs")))).check_runs
				return { commits, comments, checks }
			})

			const graphql = Effect.fnUntraced(function* (
				externalInstallationId: string,
				query: string,
				variables: Record<string, unknown>,
				context: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedSend(
					"POST",
					token,
					graphqlUrl(config.apiBaseUrl),
					{ query, variables },
					context,
				)
				if (!response.ok) return yield* failure(response, context, "repository")
				return yield* parseJson(response, context)
			})

			const graphqlFailure = (context: string, errors: ReadonlyArray<{ readonly message: string }>) =>
				new GithubAppError({
					message: `${context} failed: ${errors
						.map((error) => error.message)
						.join("; ")
						.slice(0, 300)}`,
					scope: "repository",
				})

			/** Every review thread of a pull request, with the first comments of each. */
			const listReviewThreads = Effect.fn("GithubAppClient.listReviewThreads")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
			) {
				const json = yield* graphql(
					externalInstallationId,
					REVIEW_THREADS_QUERY,
					{ owner, name: repo, number },
					"List review threads",
				)
				const decoded = yield* decodeReviewThreads(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected review threads payload", cause }),
					),
				)
				if (decoded.errors && decoded.errors.length > 0)
					return yield* graphqlFailure("List review threads", decoded.errors)
				return decoded.data?.repository?.pullRequest?.reviewThreads.nodes ?? []
			})

			// Needs `pull_requests: write`, which posting the review already required.
			const resolveReviewThread = Effect.fn("GithubAppClient.resolveReviewThread")(function* (
				externalInstallationId: string,
				threadId: string,
			) {
				const json = yield* graphql(
					externalInstallationId,
					RESOLVE_THREAD_MUTATION,
					{ threadId },
					"Resolve review thread",
				)
				const decoded = yield* decodeMutation(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected mutation payload", cause }),
					),
				)
				if (decoded.errors && decoded.errors.length > 0)
					return yield* graphqlFailure("Resolve review thread", decoded.errors)
			})

			/** The inline comments one review created, for their ids. */
			const listReviewComments = Effect.fn("GithubAppClient.listReviewComments")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				reviewId: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews/${reviewId}/comments?per_page=${PER_PAGE}`,
				)
				if (!response.ok) return yield* failure(response, "List review comments", "repository")
				return yield* decodeReviewCommentList(
					yield* parseJson(response, "List review comments"),
				).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected review comments payload", cause }),
					),
				)
			})

			const replyToReviewComment = Effect.fn("GithubAppClient.replyToReviewComment")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				commentId: string,
				body: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedSend(
					"POST",
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/comments/${encodeURIComponent(commentId)}/replies`,
					{ body },
					"Reply to review comment",
				)
				if (!response.ok) return yield* failure(response, "Reply to review comment", "repository")
				return yield* decodeCreatedComment(
					yield* parseJson(response, "Reply to review comment"),
				).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected reply payload", cause }),
					),
				)
			})

			const repoBase = (config: ResolvedAppConfig, owner: string, repo: string) =>
				`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`

			/** POST or PATCH a JSON body and decode the answer, failing repository-scoped. */
			const sendJson = <A>(
				externalInstallationId: string,
				method: "POST" | "PATCH",
				url: (config: ResolvedAppConfig) => string,
				body: unknown,
				context: string,
				schema: Schema.Decoder<A>,
			) =>
				Effect.gen(function* () {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const response = yield* authedSend(method, token, url(config), body, context)
					if (!response.ok) return yield* failure(response, context, "repository")
					return yield* Schema.decodeUnknownEffect(schema)(
						yield* parseJson(response, context),
					).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({ message: `Unexpected ${context} payload`, cause }),
						),
					)
				})

			const getPullRequestHead = Effect.fn("GithubAppClient.getPullRequestHead")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${repoBase(config, owner, repo)}/pulls/${number}`,
				)
				if (!response.ok) return yield* failure(response, "Get pull request", "repository")
				return yield* decodePullRequestHead(yield* parseJson(response, "Get pull request")).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected pull request payload", cause }),
					),
				)
			})

			const createIssueComment = Effect.fn("GithubAppClient.createIssueComment")(
				(externalInstallationId: string, owner: string, repo: string, number: number, body: string) =>
					sendJson(
						externalInstallationId,
						"POST",
						(config) => `${repoBase(config, owner, repo)}/issues/${number}/comments`,
						{ body },
						"Create comment",
						GithubApiCreatedComment,
					),
			)

			/** A reaction on a comment; `review_thread` comments live under pulls, the rest under issues. */
			const addCommentReaction = Effect.fn("GithubAppClient.addCommentReaction")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				surface: "conversation" | "review_thread",
				commentId: string,
				content: "eyes" | "+1" | "confused",
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const kind = surface === "review_thread" ? "pulls" : "issues"
				const response = yield* authedSend(
					"POST",
					token,
					`${repoBase(config, owner, repo)}/${kind}/comments/${encodeURIComponent(commentId)}/reactions`,
					{ content },
					"Add reaction",
				)
				if (!response.ok) return yield* failure(response, "Add reaction", "repository")
			})

			/** `admin`, `maintain`, `write`, `triage`, `read` or `none`. */
			const getCollaboratorPermission = Effect.fn("GithubAppClient.getCollaboratorPermission")(
				function* (externalInstallationId: string, owner: string, repo: string, login: string) {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const response = yield* authedGet(
						config,
						token,
						`${repoBase(config, owner, repo)}/collaborators/${encodeURIComponent(login)}/permission`,
					)
					// A 404 is a user who is not a collaborator at all.
					if (response.status === 404) return "none"
					if (!response.ok)
						return yield* failure(response, "Get collaborator permission", "repository")
					const decoded = yield* decodeCollaboratorPermission(
						yield* parseJson(response, "Get collaborator permission"),
					).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({ message: "Unexpected permission payload", cause }),
						),
					)
					return decoded.permission
				},
			)

			/**
			 * One commit on top of `parentSha` that writes `files`, then a fast-forward of `branch` to it.
			 * Needs `contents: write`. The ref update is never forced: a branch that moved since the
			 * parent was read answers 422, and the caller says so instead of overwriting someone's push.
			 */
			const commitFiles = Effect.fn("GithubAppClient.commitFiles")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				input: {
					readonly branch: string
					readonly parentSha: string
					readonly message: string
					readonly files: ReadonlyArray<{ readonly path: string; readonly content: string }>
				},
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = repoBase(config, owner, repo)
				const parentResponse = yield* authedGet(
					config,
					token,
					`${base}/git/commits/${input.parentSha}`,
				)
				if (!parentResponse.ok)
					return yield* failure(parentResponse, "Read parent commit", "repository")
				const parent = yield* decodeGitCommit(
					yield* parseJson(parentResponse, "Read parent commit"),
				).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected commit payload", cause }),
					),
				)
				const tree = yield* sendJson(
					externalInstallationId,
					"POST",
					() => `${base}/git/trees`,
					{
						base_tree: parent.tree.sha,
						tree: input.files.map((file) => ({
							path: file.path,
							mode: "100644",
							type: "blob",
							content: file.content,
						})),
					},
					"Create tree",
					GithubApiGitTree,
				)
				const commit = yield* sendJson(
					externalInstallationId,
					"POST",
					() => `${base}/git/commits`,
					{ message: input.message, tree: tree.sha, parents: [input.parentSha] },
					"Create commit",
					GithubApiGitCommit,
				)
				const refResponse = yield* authedSend(
					"PATCH",
					token,
					`${base}/git/refs/heads/${input.branch.split("/").map(encodeURIComponent).join("/")}`,
					{ sha: commit.sha, force: false },
					"Update branch",
				)
				if (!refResponse.ok) return yield* failure(refResponse, "Update branch", "repository")
				return { sha: commit.sha, htmlUrl: commit.html_url ?? null }
			})

			/** Paths that differ between two commits: what a push changed since the last review. */
			const compareFiles = Effect.fn("GithubAppClient.compareFiles")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				base: string,
				head: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=${PER_PAGE}`,
				)
				if (!response.ok) return yield* failure(response, "Compare commits", "repository")
				const decoded = yield* decodeComparison(yield* parseJson(response, "Compare commits")).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected comparison payload", cause }),
					),
				)
				return (decoded.files ?? []).map((file) => file.filename)
			})

			// Needs `checks: write` on the App. A 403 here is the installation not
			// having accepted that permission yet; the provider maps it to a
			// repository-scoped failure the review records as `publish_error`.
			const createCheckRun = Effect.fn("GithubAppClient.createCheckRun")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				input: GithubCheckRunInput,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedSend(
					"POST",
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs`,
					{
						name: input.name,
						head_sha: input.headSha,
						status: "completed",
						conclusion: input.conclusion,
						output: {
							title: input.title,
							summary: input.summary,
							annotations: input.annotations
								.slice(0, CHECK_RUN_ANNOTATION_LIMIT)
								.map((annotation) => ({
									path: annotation.path,
									start_line: annotation.startLine,
									end_line: annotation.endLine,
									annotation_level: annotation.level,
									title: annotation.title,
									message: annotation.message,
								})),
						},
					},
					"Create check run",
				)
				if (!response.ok) return yield* failure(response, "Create check run", "repository")
				const json = yield* parseJson(response, "Create check run")
				return yield* decodeCheckRun(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected check run payload", cause }),
					),
				)
			})

			// Needs `pull_requests: write`. `event: COMMENT` so the review never
			// approves or blocks a merge; every comment is on the new side of the
			// diff, which is the only side a line-anchored comment can name.
			const createPullRequestReview = Effect.fn("GithubAppClient.createPullRequestReview")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				input: GithubReviewInput,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedSend(
					"POST",
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/reviews`,
					{
						commit_id: input.commitId,
						body: input.body,
						event: "COMMENT",
						comments: input.comments.map((comment) => ({
							path: comment.path,
							line: comment.line,
							side: "RIGHT",
							...(comment.startLine === undefined
								? undefined
								: { start_line: comment.startLine, start_side: "RIGHT" }),
							body: comment.body,
						})),
					},
					"Create pull request review",
				)
				if (!response.ok) return yield* failure(response, "Create pull request review", "repository")
				const json = yield* parseJson(response, "Create pull request review")
				return yield* decodeReview(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected review payload", cause }),
					),
				)
			})

			/**
			 * Create or edit the one comment carrying `marker`, so every later review of the pull
			 * request updates the same comment. Only a comment this App wrote is edited: a person who
			 * quoted the marker keeps their comment, and the App could not edit it anyway.
			 */
			const upsertIssueComment = Effect.fn("GithubAppClient.upsertIssueComment")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				marker: string,
				body: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
				let existing: number | undefined
				for (let page = 1; page <= MAX_COMMENT_PAGES && existing === undefined; page++) {
					const response = yield* authedGet(
						config,
						token,
						`${base}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok)
						return yield* failure(response, "List pull request comments", "repository")
					const comments = yield* decodeIssueCommentList(
						yield* parseJson(response, "List pull request comments"),
					).pipe(
						Effect.mapError(
							(cause) => new GithubAppError({ message: "Unexpected comments payload", cause }),
						),
					)
					existing = comments.find(
						(comment) =>
							(comment.body ?? "").includes(marker) &&
							String(comment.performed_via_github_app?.id ?? "") === config.appId,
					)?.id
					if (comments.length < PER_PAGE) break
				}
				yield* Effect.annotateCurrentSpan("vcs.pull_request.comment_updated", existing !== undefined)
				const response =
					existing === undefined
						? yield* authedSend(
								"POST",
								token,
								`${base}/issues/${number}/comments`,
								{ body },
								"Create comment",
							)
						: yield* authedSend(
								"PATCH",
								token,
								`${base}/issues/comments/${existing}`,
								{ body },
								"Update comment",
							)
				if (!response.ok) return yield* failure(response, "Write pull request comment", "repository")
				return yield* decodeIssueComment(
					yield* parseJson(response, "Write pull request comment"),
				).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected comment payload", cause }),
					),
				)
			})

			const searchCode = Effect.fn("GithubAppClient.searchCode")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				queryText: string,
				path: string | undefined,
				limit: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const query = [queryText, `repo:${owner}/${repo}`, path ? `path:${path}` : undefined]
					.filter((part): part is string => part !== undefined)
					.join(" ")
				const params = new URLSearchParams({ q: query, per_page: String(limit), page: "1" })
				const response = yield* rateLimitedFetch(
					tracedFetch(
						`${config.apiBaseUrl}/search/code?${params.toString()}`,
						{
							headers: {
								authorization: `token ${token}`,
								accept: "application/vnd.github.text-match+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						},
						"GitHub code search failed",
					),
				)
				if (!response.ok) return yield* failure(response, "Search code", "repository")
				const json = yield* parseJson(response, "Search code")
				return yield* decodeCodeSearch(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected code search payload", cause }),
					),
				)
			})

			const getSourceFile = Effect.fn("GithubAppClient.getSourceFile")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				path: string,
				ref: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const encodedPath = path.split("/").map(encodeURIComponent).join("/")
				const params = new URLSearchParams({ ref })
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?${params.toString()}`,
				)
				if (!response.ok) return yield* failure(response, "Get repository file", "repository")
				const json = yield* parseJson(response, "Get repository file")
				return yield* decodeContentFile(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected repository file payload", cause }),
					),
				)
			})

			// Used by the dashboard connect flow to populate the installation row.
			const getInstallation = Effect.fn("GithubAppClient.getInstallation")(function* (
				externalInstallationId: string,
			) {
				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* rateLimitedFetch(
					tracedFetch(
						`${config.apiBaseUrl}/app/installations/${externalInstallationId}`,
						{
							headers: {
								authorization: `Bearer ${jwt}`,
								accept: "application/vnd.github+json",
								"x-github-api-version": GITHUB_API_VERSION,
								"user-agent": USER_AGENT,
							},
						},
						"Get installation request failed",
					),
				)
				if (!response.ok) return yield* failure(response, "Get installation", "installation")
				const json = yield* parseJson(response, "Get installation")
				return yield* decodeInstallationDetail(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected installation payload", cause }),
					),
				)
			})

			// The two calls below prove the user owns the installation they're connecting.

			// Trade the callback `code` for a short-lived user token.
			const exchangeUserOAuthCode = Effect.fn("GithubAppClient.exchangeUserOAuthCode")(function* (
				code: string,
			) {
				const clientId = Option.getOrUndefined(env.GITHUB_APP_CLIENT_ID)
				const clientSecret = Option.getOrUndefined(env.GITHUB_APP_CLIENT_SECRET)
				if (!clientId || !clientSecret) {
					return yield* new GithubAppError({
						message:
							"GitHub App OAuth is not configured (set GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET)",
					})
				}
				const body = new URLSearchParams({
					client_id: clientId,
					client_secret: Redacted.value(clientSecret),
					code,
				})
				const response = yield* rateLimitedFetch(
					tracedFetch(
						`${githubWebBaseUrl(env.GITHUB_API_BASE_URL)}/login/oauth/access_token`,
						{
							method: "POST",
							headers: {
								accept: "application/json",
								"content-type": "application/x-www-form-urlencoded",
								"user-agent": USER_AGENT,
							},
							body: body.toString(),
						},
						"GitHub OAuth code exchange failed",
					),
				)
				if (!response.ok) return yield* failure(response, "GitHub OAuth code exchange")
				const json = yield* parseJson(response, "GitHub OAuth code exchange")
				const decoded = yield* decodeOAuthToken(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected OAuth token payload", cause }),
					),
				)
				// GitHub reports OAuth errors as a 200 with an `error` field, not an HTTP error.
				if (!decoded.access_token) {
					return yield* new GithubAppError({
						message: `GitHub OAuth code exchange rejected: ${decoded.error_description ?? decoded.error ?? "no access_token"}`,
						status: 401,
					})
				}
				return decoded.access_token
			})

			const listUserInstallationIds = Effect.fn("GithubAppClient.listUserInstallationIds")(function* (
				userAccessToken: string,
			) {
				const config = yield* resolveConfig
				const ids = new Set<string>()
				for (let page = 1; page <= MAX_PAGES; page++) {
					const response = yield* authedGet(
						config,
						userAccessToken,
						`${config.apiBaseUrl}/user/installations?per_page=${PER_PAGE}&page=${page}`,
					)
					if (!response.ok) return yield* failure(response, "List user installations")
					const json = yield* parseJson(response, "List user installations")
					const decoded = yield* decodeUserInstallations(json).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({
									message: "Unexpected user installations payload",
									cause,
								}),
						),
					)
					for (const installation of decoded.installations) ids.add(String(installation.id))
					if (decoded.installations.length < PER_PAGE) break
				}
				return ids
			})

			return {
				mintInstallationToken,
				listInstallationRepositories,
				listBranches,
				listCommits,
				getCommit,
				listPullRequests,
				getPullRequest,
				listPullRequestFiles,
				getPullRequestContext,
				listReviewThreads,
				resolveReviewThread,
				listReviewComments,
				replyToReviewComment,
				compareFiles,
				getPullRequestHead,
				createIssueComment,
				addCommentReaction,
				getCollaboratorPermission,
				commitFiles,
				createCheckRun,
				createPullRequestReview,
				upsertIssueComment,
				searchCode,
				getSourceFile,
				mintCloneCredentials,
				getInstallation,
				exchangeUserOAuthCode,
				listUserInstallationIds,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(GithubHttp.layer))
}
