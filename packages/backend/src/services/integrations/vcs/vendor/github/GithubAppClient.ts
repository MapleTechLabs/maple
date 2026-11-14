import { GitCommitSha, VcsRepositoryBlockedError, VcsRepoUnavailableError } from "@maple/domain/http"
import {
	Array as Arr,
	Clock,
	Context,
	Duration,
	Effect,
	Layer,
	Option,
	Redacted,
	Ref,
	Schedule,
	Semaphore,
	Schema,
	Stream,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { githubWebBaseUrl } from "./github-hosts"
import { timestampMs } from "@maple/backend/platform/time"
import { pemToPkcs8, RS256, signJwt } from "@maple/backend/platform/jwt"
import * as VendorHttp from "../../../vendor-http"
import { makeExpiringStore } from "@maple/backend/platform/expiring-store"
import { type InstallationToken, SharedInstallationTokens } from "../../installation-tokens"
import type { VcsBillingMonth, VcsBillingUsageAnswer } from "../../VcsProviderClient"

// GitHub App REST client. Vendor-specific: mints a short-lived App JWT (RS256,
// Web Crypto), exchanges it for per-installation tokens, and calls the GitHub
// REST API. No Octokit (Worker bundle weight). This module never touches the application database.
//
// `GithubAppError` is internal to the GitHub layer; `GithubProvider` maps it to
// the generic `VcsProviderError` at the port boundary.

export class GithubAppError extends Schema.TaggedError<GithubAppError>()(
	"@maple/backend/vcs/GithubAppError",
	{
		message: Schema.String,
		status: Schema.optionalKey(Schema.Number),
		// Which resource the failing call addressed, so the provider can tell an
		// installation-auth failure (the gone/suspended signal) from a repo-level one.
		scope: Schema.optionalKey(Schema.Literals(["installation", "repository"])),
		// Set when the failure is a rate limit too far out to wait through inline:
		// seconds until the budget returns. The provider maps this to VcsRateLimitedError.
		retryAfterSeconds: Schema.optionalKey(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect()),
	},
) {}

/** GitHub's answer for a resource that is gone or that this installation can no longer see. */
export const isGoneStatus = (status?: number) => status === 404 || status === 410

// GitHub answers 451 for a repository taken down for legal reasons, and carries
// the same `{"block":{"reason":"dmca"}}` body on the 403 variant. Neither clears
// on retry, so both are terminal — matched on the body rather than on 403 alone,
// which is otherwise an ordinary (retryable) permission failure.
const BLOCK_BODY = /"block"\s*:|Repository access blocked/
export const isBlockedRepository = (error: GithubAppError) =>
	error.status === 451 || (error.status === 403 && BLOCK_BODY.test(error.message))

export type RepositoryListingError = GithubAppError | VcsRepoUnavailableError | VcsRepositoryBlockedError

// A gone or blocked repository is an answer the sync records, not a client fault. Failing with
// the anticipated domain error keeps the listing span out of error tracking.
const toRepositoryListingError = (error: GithubAppError): RepositoryListingError => {
	if (error.retryAfterSeconds !== undefined) return error
	if (isBlockedRepository(error)) {
		return new VcsRepositoryBlockedError({
			message: error.message,
			...(error.status === undefined ? undefined : { status: error.status }),
		})
	}
	if (isGoneStatus(error.status)) return new VcsRepoUnavailableError({ message: error.message })
	return error
}

const GITHUB_API_VERSION = "2022-11-28"
const USER_AGENT = "maple-vcs-integration"
const PER_PAGE = 100
// GitHub's cap on the files one comparison lists.
const MAX_COMPARE_FILES = 300
// Paginate effectively to the end (up to 100k items) while still bounding a
// pathological loop. Hitting this cap is logged — truncation is never silent.
const MAX_PAGES = 1000
/** Pages of check-run annotations read looking for a failure, past warnings and notices. */
const MAX_ANNOTATION_PAGES = 3
/**
 * A job's log can trail its `completed` webhook by a few seconds; until then GitHub answers 404.
 * Three retries from two seconds wait out about fourteen.
 */
const JOB_LOG_NOT_READY_RETRIES = 3
const JOB_LOG_NOT_READY_BACKOFF = Duration.seconds(2)
/** The log store's 503 (`ServerBusy`) passes; three retries from one second wait about seven. */
const JOB_LOG_BUSY_RETRIES = 3
const JOB_LOG_BUSY_BACKOFF = Duration.seconds(1)
/** GitHub lists at most 3,000 files for one pull request. */
const MAX_PR_FILE_PAGES = 30

/**
 * Pages 1..maxPages in order until a page comes back shorter than PER_PAGE.
 * `truncated` means the cap was hit on a full page, so more may remain.
 */
const collectPages = <A, E, R>(
	maxPages: number,
	fetchPage: (page: number) => Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
	Stream.paginate(1, (page: number) =>
		fetchPage(page).pipe(
			Effect.map((items) => {
				const full = items.length >= PER_PAGE
				return [
					[{ items, full }],
					full && page < maxPages ? Option.some(page + 1) : Option.none<number>(),
				] as const
			}),
		),
	).pipe(
		Stream.runCollect,
		Effect.map((pages) => ({
			items: Arr.flatMap(pages, (page) => page.items),
			truncated: pages.at(-1)?.full === true,
		})),
	)
// Pages walked per consumer invocation before yielding a continuation. Caps
// wall-clock per invocation to stay under Cloudflare Queues' 15-min limit;
// the remainder resumes from a committer-date watermark in a follow-up job.
export const COMMIT_PAGES_PER_INVOCATION = 25
// Ride out short rate limits inline; anything longer is surfaced so the caller
// can defer (backfill requeues from a cursor; other jobs get a delayed retry).
const INLINE_BACKOFF_CAP_S = 30
// Retire a cached token this early so it never expires mid-request. Tokens last
// ~1h, so the extra minute just costs an occasional re-mint.
const INSTALLATION_TOKEN_EXPIRY_SKEW_MS = 60_000
// A cached token that lacks `actions: read` is re-minted once it is this old, so a permission
// accepted since the mint applies within minutes, not when the token expires.
const PERMISSION_DENIAL_RECHECK_MS = 5 * 60_000
// A token without the billing permission is re-minted once it is this old: a person who accepts the
// permission in GitHub and tries again is not kept waiting, and two reads in a row mint once.
const BILLING_PERMISSION_RECHECK_MS = 10_000

// A GitHub rate-limit response is a 429, or a 403 that carries `retry-after` /
// reports zero remaining (the secondary-limit shape). Plain 403s (permissions)
// are NOT rate limits.
const classifyGithub = (refusal: VendorHttp.VendorRefusal): VendorHttp.VendorFailureKind | undefined =>
	refusal.status === 403 &&
	(refusal.headers["retry-after"] !== undefined || refusal.headers["x-ratelimit-remaining"] === "0")
		? "rate_limited"
		: undefined

/** GitHub's error body is `{ message, documentation_url }`. */
const GithubErrorBody = Schema.Struct({ message: Schema.String })
const decodeGithubErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(GithubErrorBody))
const githubDetail = (body: string) =>
	Option.match(decodeGithubErrorBody(body), { onNone: () => undefined, onSome: (b) => b.message })

const decodeJsonText = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/**
 * What GitHub answered: a 2xx body, or a refusal the caller reads by status. Rate limits,
 * timeouts and transport failures never become an answer; they fail as a `GithubAppError`.
 */
type GithubAnswer =
	| { readonly ok: true; readonly body: string }
	| {
			readonly ok: false
			readonly status: number
			readonly body: string
			readonly detail?: string
			readonly location?: string
	  }

/** The refusal status of an answer; none for a 2xx. */
const statusOf = (answer: GithubAnswer) => (answer.ok ? undefined : answer.status)

const isOk = (answer: GithubAnswer): boolean => answer.ok

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 307, 308])

/** An installation or user token, in the `token` scheme GitHub documents for both. */
const tokenAuth =
	(token: string): VendorHttp.VendorAuth =>
	(request) =>
		HttpClientRequest.setHeader(request, "authorization", `token ${token}`)

/** Per attempt: the answer's headers and, for a read into memory, its whole body. */
const REQUEST_TIMEOUT = Duration.seconds(30)

/** A body as text, failing with `tooLarge` once it passes `maxBytes` instead of buffering on. */
const readTextWithin = <E>(
	body: Stream.Stream<Uint8Array, E>,
	maxBytes: number,
	tooLarge: () => E,
): Effect.Effect<string, E> =>
	Effect.suspend(() => {
		const decoder = new TextDecoder()
		return body.pipe(
			Stream.runFoldEffect(
				() => ({ text: "", bytes: 0 }),
				(read, chunk: Uint8Array) =>
					read.bytes + chunk.byteLength > maxBytes
						? Effect.fail(tooLarge())
						: Effect.succeed({
								text: read.text + decoder.decode(chunk, { stream: true }),
								bytes: read.bytes + chunk.byteLength,
							}),
			),
			Effect.map((read) => read.text + decoder.decode()),
		)
	})

const GithubInstallationTokenResponse = Schema.Struct({
	token: Schema.String,
	expires_at: Schema.String,
	// What the installation has accepted, e.g. `{ actions: "read" }`. A permission it never
	// accepted is absent, so its calls would 403.
	permissions: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
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

// `GET /user/installations`: the installations this user can access (not necessarily administer).
const GithubUserInstallationsResponse = Schema.Struct({
	total_count: Schema.Number,
	installations: Schema.Array(Schema.Struct({ id: Schema.Number })),
})

// `GET /user` and `GET /user/memberships/orgs/{org}`: who the user is and their role in an org.
const GithubAuthenticatedUser = Schema.Struct({ id: Schema.Number, login: Schema.String })
const GithubOrgMembership = Schema.Struct({ state: Schema.String, role: Schema.String })

/** Whether a user token's owner administers an installation's account. */
export type GithubAccountAdminCheck = "admin" | "not-admin" | "unverifiable"

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

// A commit's `author` is a user, null, or `{}` when its email maps to no account.
const GithubApiCommitUser = Schema.Struct({
	login: Schema.optionalKey(Schema.String),
	avatar_url: Schema.optionalKey(Schema.String),
})

const GithubApiCommitSchema = Schema.Struct({
	sha: GitCommitSha,
	html_url: Schema.String,
	commit: Schema.Struct({
		message: Schema.String,
		author: Schema.NullOr(GithubApiCommitAuthor),
		committer: Schema.optionalKey(Schema.NullOr(GithubApiCommitAuthor)),
	}),
	author: Schema.NullOr(GithubApiCommitUser),
})
export type GithubApiCommit = Schema.Schema.Type<typeof GithubApiCommitSchema>

/** A commit walk: complete, or cut short with the commits fetched so far. */
type CommitWalk =
	| { readonly commits: ReadonlyArray<GithubApiCommit>; readonly complete: true }
	| {
			readonly commits: ReadonlyArray<GithubApiCommit>
			readonly complete: false
			readonly reason: "page-budget"
	  }
	| {
			readonly commits: ReadonlyArray<GithubApiCommit>
			readonly complete: false
			readonly reason: "rate-limited"
			readonly retryAfterSeconds: number
	  }

const GithubApiCommitList = Schema.Array(GithubApiCommitSchema)

const GithubApiBranchSchema = Schema.Struct({
	name: Schema.String,
	commit: Schema.Struct({ sha: GitCommitSha }),
})
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
			app: Schema.optionalKey(Schema.NullOr(Schema.Struct({ id: Schema.Number }))),
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
const GithubApiGitTreeListing = Schema.Struct({
	tree: Schema.Array(
		Schema.Struct({ path: Schema.String, mode: Schema.String, type: Schema.String, sha: Schema.String }),
	),
})

/** Git's well-known hash of a tree with no entries. */
const EMPTY_TREE_SHA = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"
/** Reads one truncated tree's walk may make: a monorepo needs one per directory it splits. */
const MAX_TREE_WALK_READS = 400
/**
 * Entries a walk holds at most: 1.5 times GitHub's 100,000 per read, about 60 MB of heap with the
 * caller's copy, well inside a Worker's 128 MB.
 */
const MAX_TREE_WALK_ENTRIES = 150_000
const TREE_WALK_CONCURRENCY = 4
/** A recursive listing; `size` is set on blobs only, `truncated` when GitHub cut the listing short. */
const GithubApiRecursiveTree = Schema.Struct({
	sha: Schema.String,
	truncated: Schema.Boolean,
	tree: Schema.Array(
		Schema.Struct({
			path: Schema.String,
			type: Schema.String,
			sha: Schema.String,
			size: Schema.optionalKey(Schema.Number),
		}),
	),
})
export type GithubRecursiveTree = typeof GithubApiRecursiveTree.Type

const GithubApiReviewCommentList = Schema.Array(
	Schema.Struct({
		id: Schema.Number,
		path: Schema.String,
		line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		original_line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
	}),
)
// `status` says how the two commits relate: `ahead` or `identical` when base is an ancestor of
// head, `behind` or `diverged` otherwise (a force-push or a rebase).
const GithubApiComparison = Schema.Struct({
	status: Schema.Literals(["ahead", "behind", "diverged", "identical"]),
	files: Schema.optionalKey(
		Schema.Array(
			Schema.Struct({
				filename: Schema.String,
				previous_filename: Schema.optionalKey(Schema.String),
				status: Schema.String,
				patch: Schema.optionalKey(Schema.String),
			}),
		),
	),
})
export type GithubApiComparison = Schema.Schema.Type<typeof GithubApiComparison>
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
														reactionGroups: Schema.optionalKey(
															Schema.NullOr(
																Schema.Array(
																	Schema.Struct({
																		content: Schema.String,
																		reactors: Schema.Struct({
																			totalCount: Schema.Number,
																		}),
																	}),
																),
															),
														),
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
export type GithubApiDiscussionComment = Schema.Schema.Type<typeof GithubApiDiscussionCommentList>[number]

const GithubApiCheckRunSchema = Schema.Struct({
	id: Schema.Number,
	status: Schema.String,
	html_url: Schema.NullOr(Schema.String),
})
const GithubApiOwnCheckRunList = Schema.Struct({ check_runs: Schema.Array(GithubApiCheckRunSchema) })
const GithubApiIssueCommentSchema = Schema.Struct({
	id: Schema.Number,
	node_id: Schema.optionalKey(Schema.String),
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
	/** `in_progress` while the review runs; the same run is then completed with its result. */
	readonly state:
		| { readonly status: "in_progress" }
		| { readonly status: "completed"; readonly conclusion: "success" | "neutral" | "failure" | "skipped" }
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
type GithubContentFile = Schema.Schema.Type<typeof GithubContentFileSchema>

const decodeRepositorySize = Schema.decodeUnknownEffect(Schema.Struct({ size: Schema.Number }))
const decodeOAuthToken = Schema.decodeUnknownEffect(GithubOAuthTokenResponse)
const decodeUserInstallations = Schema.decodeUnknownEffect(GithubUserInstallationsResponse)
const decodeAuthenticatedUser = Schema.decodeUnknownEffect(GithubAuthenticatedUser)
const decodeOrgMembership = Schema.decodeUnknownEffect(GithubOrgMembership)
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
const decodeOwnCheckRunList = Schema.decodeUnknownEffect(GithubApiOwnCheckRunList)
const decodeCheckRunAnnotations = Schema.decodeUnknownEffect(
	Schema.Array(
		Schema.Struct({
			annotation_level: Schema.optionalKey(Schema.NullOr(Schema.String)),
			message: Schema.optionalKey(Schema.NullOr(Schema.String)),
			title: Schema.optionalKey(Schema.NullOr(Schema.String)),
			path: Schema.optionalKey(Schema.NullOr(Schema.String)),
			start_line: Schema.optionalKey(Schema.NullOr(Schema.Number)),
		}),
	),
)
const decodePullRequestCommits = Schema.decodeUnknownEffect(GithubApiPullRequestCommitList)
const decodeDiscussionComments = Schema.decodeUnknownEffect(GithubApiDiscussionCommentList)
const decodeCheckRunList = Schema.decodeUnknownEffect(GithubApiCheckRunList)
const decodeReviewCommentList = Schema.decodeUnknownEffect(GithubApiReviewCommentList)
const decodePullRequestHead = Schema.decodeUnknownEffect(GithubApiPullRequestHead)
const decodeCreatedComment = Schema.decodeUnknownEffect(GithubApiCreatedComment)
const decodeCollaboratorPermission = Schema.decodeUnknownEffect(GithubApiCollaboratorPermission)
const decodeGitCommit = Schema.decodeUnknownEffect(GithubApiGitCommit)
const decodeGitTreeListing = Schema.decodeUnknownEffect(GithubApiGitTreeListing)
const decodeRecursiveTree = Schema.decodeUnknownEffect(GithubApiRecursiveTree)
const decodeComparison = Schema.decodeUnknownEffect(GithubApiComparison)
const decodeReviewThreads = Schema.decodeUnknownEffect(GithubReviewThreadsResponse)
const decodeMutation = Schema.decodeUnknownEffect(GithubMutationResponse)

const REVIEW_THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved
          comments(first: 20) {
            nodes { databaseId author { login } body reactionGroups { content reactors { totalCount } } }
          }
        }
      }
    }
  }
}`
const RESOLVE_THREAD_MUTATION = `mutation($threadId: ID!) {
  resolveReviewThread(input: { threadId: $threadId }) { thread { id } }
}`

const COMMENT_STATES_QUERY = `query($ids: [ID!]!) {
  nodes(ids: $ids) { ... on IssueComment { id isMinimized } }
}`
const MINIMIZE_COMMENT_MUTATION = `mutation($id: ID!) {
  minimizeComment(input: { subjectId: $id, classifier: OUTDATED }) { minimizedComment { isMinimized } }
}`
const GithubCommentStatesResponse = Schema.Struct({
	data: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				nodes: Schema.Array(
					Schema.NullOr(
						Schema.Struct({
							id: Schema.optionalKey(Schema.String),
							isMinimized: Schema.optionalKey(Schema.Boolean),
						}),
					),
				),
			}),
		),
	),
	errors: GithubGraphqlErrors,
})
const decodeCommentStates = Schema.decodeUnknownEffect(GithubCommentStatesResponse)

/** GitHub.com serves GraphQL at `/graphql`; Enterprise at `/api/graphql` beside `/api/v3`. */
const graphqlUrl = (apiBaseUrl: string) =>
	Str.endsWith("/api/v3")(apiBaseUrl)
		? `${Str.slice(0, -"/v3".length)(apiBaseUrl)}/graphql`
		: `${apiBaseUrl}/graphql`
const decodeReview = Schema.decodeUnknownEffect(GithubApiReviewSchema)
const decodeIssueComment = Schema.decodeUnknownEffect(GithubApiIssueCommentSchema)
const decodeIssueCommentList = Schema.decodeUnknownEffect(GithubApiIssueCommentList)
const decodeCodeSearch = Schema.decodeUnknownEffect(GithubCodeSearchResponseSchema)
const decodeContentFile = Schema.decodeUnknownEffect(GithubContentFileSchema)

/** GitHub answers 401 to a revoked or expired token; some endpoints answer 403 "Bad credentials". */
const rejectsCredentials = (answer: GithubAnswer) =>
	!answer.ok &&
	(answer.status === 401 ||
		(answer.status === 403 &&
			(answer.detail === "Bad credentials" || Str.includes("Bad credentials")(answer.body))))

interface GithubCall {
	readonly method?: "GET" | "POST" | "PATCH" | "DELETE"
	readonly url: string
	readonly auth: VendorHttp.VendorAuth
	readonly accept?: string
	/** Sent as JSON. */
	readonly body?: unknown
	readonly errorMessage: string
	/** Retry transient failures; defaults to the kit's rule (GET and DELETE only). */
	readonly retry?: boolean
}

interface ResolvedAppConfig {
	readonly appId: string
	readonly privateKeyPem: string
	readonly apiBaseUrl: string
}

export class GithubAppClient extends Context.Service<GithubAppClient>()(
	"@maple/backend/services/vcs/vendor/github/GithubAppClient",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient

			// Reuse one token per installation instead of minting a fresh one per repo. Tokens last
			// ~1h. A Worker provides one store for the isolate so the cache outlives one event.
			const installationTokens =
				(yield* SharedInstallationTokens) ?? (yield* makeExpiringStore<InstallationToken>())

			/** The kit over GitHub; every call names its whole URL, so the base is empty. */
			const githubHttp = (
				auth: VendorHttp.VendorAuth,
				headers: Readonly<Record<string, string>>,
				retry?: Schedule.Schedule<unknown>,
			) =>
				VendorHttp.make({
					httpClient,
					peerService: "github",
					baseUrl: "",
					auth,
					headers,
					classify: classifyGithub,
					detail: githubDetail,
					toError: (error: VendorHttp.VendorHttpError) => error,
					timeout: REQUEST_TIMEOUT,
					// Short rate limits are ridden out inline; anything longer is surfaced to defer.
					maxRetryAfter: Duration.seconds(INLINE_BACKOFF_CAP_S),
					rateLimitResetHeader: "x-ratelimit-reset",
					rateLimitResetFormat: "epoch-seconds",
					...(retry === undefined ? undefined : { retry }),
				})

			const apiHeaders = (accept = "application/vnd.github+json") => ({
				accept,
				"x-github-api-version": GITHUB_API_VERSION,
				"user-agent": USER_AGENT,
			})

			/**
			 * A rate limit too far out to wait inline carries its wait; one already waited out once
			 * (or with no wait given) defers at least a minute, so a server reporting tiny waits
			 * cannot drive an immediate-redelivery loop.
			 */
			const rateLimitError = (error: VendorHttp.VendorHttpError) => {
				const waited = error.retryAfterSeconds
				const retryAfterSeconds =
					waited !== undefined && waited > INLINE_BACKOFF_CAP_S
						? waited
						: Math.max(waited ?? 60, 60)
				return new GithubAppError({
					message: `GitHub rate limited (retry after ${retryAfterSeconds}s)`,
					...(error.status === undefined ? undefined : { status: error.status }),
					retryAfterSeconds,
				})
			}

			/** A refusal with a status is an answer; a rate limit, timeout or broken transport fails. */
			const answerOf = (
				error: VendorHttp.VendorHttpError,
				errorMessage: string,
			): Effect.Effect<GithubAnswer, GithubAppError> => {
				if (error.kind === "rate_limited") return Effect.fail(rateLimitError(error))
				if (error.status === undefined)
					return Effect.fail(new GithubAppError({ message: errorMessage, cause: error }))
				return Effect.succeed({
					ok: false,
					status: error.status,
					body: error.body ?? "",
					...(error.detail === undefined ? undefined : { detail: error.detail }),
					...(error.location === undefined ? undefined : { location: error.location }),
				})
			}

			// Every GitHub REST call goes through here, so each attempt is one Client span with
			// `peer.service: github` and the URL path only: `search/code?q=` carries the caller's
			// search text, which has no business in telemetry. Tokens travel in headers.
			const send = (call: GithubCall): Effect.Effect<GithubAnswer, GithubAppError> =>
				githubHttp(call.auth, apiHeaders(call.accept))
					.text({
						method: call.method ?? "GET",
						path: call.url,
						...(call.body === undefined ? undefined : { body: call.body }),
						...(call.retry === undefined ? undefined : { retry: call.retry }),
					})
					.pipe(
						Effect.map((body): GithubAnswer => ({ ok: true, body })),
						Effect.catch((error) => answerOf(error, call.errorMessage)),
					)

			/** A same-origin redirect (a renamed repository) is followed once; another host's is not. */
			const sameOriginRedirect = (answer: GithubAnswer, from: string) => {
				if (answer.ok || !REDIRECT_STATUSES.has(answer.status) || answer.location === undefined)
					return undefined
				const target = Option.liftThrowable((location: string) => new URL(location, from))(
					answer.location,
				)
				const source = Option.liftThrowable((url: string) => new URL(url))(from)
				return Option.isSome(target) &&
					Option.isSome(source) &&
					target.value.origin === source.value.origin
					? target.value.href
					: undefined
			}

			/** Drops a token GitHub rejected from the cache, so the next call mints a fresh one. */
			const evictIfRejected = (token: string, answer: GithubAnswer) =>
				rejectsCredentials(answer)
					? installationTokens
							.removeWhere((cached) => cached.token === token)
							.pipe(
								Effect.andThen(
									Effect.annotateCurrentSpan({ "vcs.provider.token_evicted": true }),
								),
							)
					: Effect.void

			/** A call with an installation (or user) token; a token GitHub rejects is evicted from the cache. */
			const tokenCall = (token: string, call: Omit<GithubCall, "auth">, follow: boolean) => {
				const once = (url: string) =>
					send({ ...call, url, auth: tokenAuth(token) }).pipe(
						Effect.tap((answer) => evictIfRejected(token, answer)),
					)
				return once(call.url).pipe(
					Effect.flatMap((answer) => {
						const next = follow ? sameOriginRedirect(answer, call.url) : undefined
						return next === undefined ? Effect.succeed(answer) : once(next)
					}),
				)
			}

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
					apiBaseUrl: Str.replace(/\/+$/, "")(env.GITHUB_API_BASE_URL),
				}
			})

			const importSigningKey = (pem: string) =>
				Effect.tryPromise({
					try: () => crypto.subtle.importKey("pkcs8", pemToPkcs8(pem), RS256, false, ["sign"]),
					catch: (cause) =>
						new GithubAppError({ message: "Failed to import GitHub App private key", cause }),
				})

			const mintAppJwt = Effect.fn("GithubAppClient.mintAppJwt")(function* (config: ResolvedAppConfig) {
				const nowSec = Math.floor((yield* Clock.currentTimeMillis) / 1000)
				const key = yield* importSigningKey(config.privateKeyPem)
				// iat back-dated 60s for clock skew; exp under 10min per GitHub's limit.
				return yield* signJwt(
					key,
					RS256,
					{ alg: "RS256", typ: "JWT" },
					{ iat: nowSec - 60, exp: nowSec + 540, iss: config.appId },
				).pipe(
					Effect.mapError(
						(error) =>
							new GithubAppError({
								message:
									error.reason === "encode"
										? "Failed to encode App JWT"
										: "JWT signing failed",
								cause: error.cause,
							}),
					),
				)
			})

			const failure = (answer: GithubAnswer, context: string, scope?: "installation" | "repository") =>
				Effect.fail(
					new GithubAppError({
						message: `${context} failed: ${statusOf(answer) ?? ""} ${Str.slice(0, 300)(answer.body)}`,
						...(answer.ok ? undefined : { status: answer.status }),
						// The key is left out, not undefined: the error's constructor refuses `scope: undefined`.
						...(scope === undefined ? undefined : { scope }),
					}),
				)

			const parseJson = (answer: GithubAnswer, context: string) =>
				decodeJsonText(answer.body).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: `${context} returned a non-JSON response`, cause }),
					),
				)

			const installationToken = Effect.fn("GithubAppClient.mintInstallationToken")(function* (
				externalInstallationId: string,
			) {
				// Return a cached token if it's still good, so we don't re-mint per repo.
				const cached = yield* installationTokens.get(
					externalInstallationId,
					INSTALLATION_TOKEN_EXPIRY_SKEW_MS,
				)
				if (Option.isSome(cached)) {
					yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "hit" })
					return cached.value
				}
				yield* Effect.annotateCurrentSpan({ "vcs.provider.token_cache": "miss" })

				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* send({
					method: "POST",
					url: `${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`,
					auth: VendorHttp.bearer(jwt),
					errorMessage: "Installation token request failed",
				})
				// A non-rate-limit failure here is the installation auth gate: the
				// authoritative "installation gone / suspended" signal (rate limits already
				// failed in `send`).
				if (!isOk(response))
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
				const minted: InstallationToken = {
					token: decoded.token,
					expiresAtMs: timestampMs(decoded.expires_at),
					mintedAtMs: yield* Clock.currentTimeMillis,
					permissions: decoded.permissions,
				}
				if (Number.isFinite(minted.expiresAtMs)) {
					yield* installationTokens.set(externalInstallationId, minted, minted.expiresAtMs)
				}
				return minted
			})

			const mintInstallationToken = (externalInstallationId: string) =>
				installationToken(externalInstallationId).pipe(Effect.map((minted) => minted.token))

			// Job logs need `actions: read`. An installation that has not accepted it gets a 403 on
			// every log download, so callers skip the download. No permissions listed: assume granted.
			const grants =
				(permission: string) =>
				({ permissions }: InstallationToken) =>
					permissions === undefined ||
					permissions[permission] === "read" ||
					permissions[permission] === "write"
			const grantsActions = grants("actions")
			const canReadActions = Effect.fnUntraced(function* (externalInstallationId: string) {
				const token = yield* installationToken(externalInstallationId)
				const now = yield* Clock.currentTimeMillis
				if (grantsActions(token) || now - token.mintedAtMs < PERMISSION_DENIAL_RECHECK_MS) {
					return grantsActions(token)
				}
				yield* installationTokens.remove(externalInstallationId)
				const refreshed = yield* installationToken(externalInstallationId)
				return grantsActions(refreshed)
			})

			const authedGet = (
				_config: ResolvedAppConfig,
				token: string,
				url: string,
				accept = "application/vnd.github+json",
			) => tokenCall(token, { url, accept, errorMessage: `GitHub request failed: ${url}` }, true)

			// The billing report needs organization "Administration: read", which a token lists as
			// `organization_administration`.
			const grantsBillingRead = grants("organization_administration")

			// A token minted before the organization accepted the permission never gains it, so one
			// that lacks it is minted again, unless it is so new that it shows what is accepted now.
			const billingToken = Effect.fnUntraced(function* (externalInstallationId: string) {
				const cached = yield* installationToken(externalInstallationId)
				const now = yield* Clock.currentTimeMillis
				if (grantsBillingRead(cached) || now - cached.mintedAtMs < BILLING_PERMISSION_RECHECK_MS) {
					return cached
				}
				yield* installationTokens.remove(externalInstallationId)
				return yield* installationToken(externalInstallationId)
			})

			/** One month of an organization's billed usage, or how GitHub refused it: a 4xx is an answer. */
			const getOrganizationBillingUsage = Effect.fn("GithubAppClient.getOrganizationBillingUsage")(
				function* (
					externalInstallationId: string,
					org: string,
					period: VcsBillingMonth,
				): Effect.fn.Return<VcsBillingUsageAnswer, GithubAppError> {
					const config = yield* resolveConfig
					const read = Effect.gen(function* () {
						const token = yield* billingToken(externalInstallationId)
						if (!grantsBillingRead(token)) return undefined
						return yield* authedGet(
							config,
							token.token,
							`${config.apiBaseUrl}/organizations/${encodeURIComponent(org)}/settings/billing/usage?year=${period.year}&month=${period.month}`,
						)
					})
					const first = yield* read
					// A cached token GitHub rejects was evicted by the request: one more try mints a new one.
					const response = first !== undefined && statusOf(first) === 401 ? yield* read : first
					if (response === undefined) return { _tag: "NotGranted" }
					if (response.ok) return { _tag: "Usage", body: response.body }
					if (response.status >= 500) return yield* failure(response, "Billing usage report")
					return {
						_tag: "Refused",
						status: response.status,
						body: Str.slice(0, 300)(response.body),
					}
				},
			)

			const listInstallationRepositories = Effect.fn("GithubAppClient.listInstallationRepositories")(
				function* (externalInstallationId: string) {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const { items: repos, truncated } = yield* collectPages(MAX_PAGES, (page) =>
						Effect.gen(function* () {
							const response = yield* authedGet(
								config,
								token,
								`${config.apiBaseUrl}/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
							)
							if (!isOk(response))
								return yield* failure(response, "List installation repositories")
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
							return decoded.repositories
						}),
					)
					// Exhausted the page cap without a short final page → likely truncated.
					if (truncated) {
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
				const { items: branches, truncated } = yield* collectPages(MAX_PAGES, (page) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							token,
							`${base}?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response))
							return yield* failure(response, "List branches", "repository").pipe(
								Effect.mapError(toRepositoryListingError),
							)
						const json = yield* parseJson(response, "List branches")
						return yield* decodeBranchList(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected branches payload", cause }),
							),
						)
					}),
				)
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
				const rateLimited = (
					error: RepositoryListingError,
					commits: ReadonlyArray<GithubApiCommit>,
				) =>
					!Schema.is(GithubAppError)(error) || error.retryAfterSeconds === undefined
						? Effect.fail(error)
						: Effect.succeed({
								commits,
								complete: false as const,
								reason: "rate-limited" as const,
								retryAfterSeconds: error.retryAfterSeconds,
							})
				return yield* Effect.gen(function* () {
					const config = yield* resolveConfig
					const token = yield* mintInstallationToken(externalInstallationId)
					const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits`
					const fetchPage = Effect.fnUntraced(function* (page: number) {
						const query = new URLSearchParams({ per_page: String(PER_PAGE), page: String(page) })
						if (params.sha) query.set("sha", params.sha)
						if (params.sinceIso) query.set("since", params.sinceIso)
						if (params.untilIso) query.set("until", params.untilIso)
						const response = yield* authedGet(config, token, `${base}?${query.toString()}`)
						// 409 = empty repository → genuinely no commits, not an error.
						if (statusOf(response) === 409) return undefined
						// Anything else non-2xx (incl. 404 = repo deleted / access lost) is
						// surfaced as a repository-scoped failure so the orchestrator can mark
						// the repo unavailable rather than mistaking it for an empty repo.
						if (!isOk(response))
							return yield* failure(response, "List commits", "repository").pipe(
								Effect.mapError(toRepositoryListingError),
							)
						const json = yield* parseJson(response, "List commits")
						return yield* decodeCommitList(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected commits payload", cause }),
							),
						)
					})
					// Commits fetched before a rate limit are kept in the partial result.
					const walk = (
						page: number,
						commits: ReadonlyArray<GithubApiCommit>,
					): Effect.Effect<CommitWalk, RepositoryListingError> =>
						page > COMMIT_PAGES_PER_INVOCATION
							? // Full final page with no break → more remain; yield a continuation.
								Effect.succeed({
									commits,
									complete: false as const,
									reason: "page-budget" as const,
								})
							: fetchPage(page).pipe(
									Effect.matchEffect({
										onFailure: (error) => rateLimited(error, commits),
										onSuccess: (
											decoded,
										): Effect.Effect<CommitWalk, RepositoryListingError> => {
											if (decoded === undefined)
												return Effect.succeed({ commits, complete: true as const })
											const next = [...commits, ...decoded]
											return decoded.length < PER_PAGE
												? Effect.succeed({ commits: next, complete: true as const })
												: walk(page + 1, next)
										},
									}),
								)
					return yield* walk(1, [])
				}).pipe(Effect.catch((error) => rateLimited(error, [])))
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
				// 404 (not in this repo), 422 ("No commit found for SHA") and the empty-repository 409
				// are answers, not failures: none, so the span stays Ok. Any other 409 still fails.
				const refused = statusOf(response)
				if (refused === 404 || refused === 422) return Option.none<GithubApiCommit>()
				if (refused === 409) {
					if (Str.includes("Git Repository is empty")(response.body))
						return Option.none<GithubApiCommit>()
					return yield* failure(response, "Get commit", "repository")
				}
				if (!isOk(response)) return yield* failure(response, "Get commit", "repository")
				const json = yield* parseJson(response, "Get commit")
				return yield* decodeCommit(json).pipe(
					Effect.mapBoth({
						onSuccess: Option.some,
						onFailure: (cause) =>
							new GithubAppError({ message: "Unexpected commit payload", cause }),
					}),
				)
			})

			/** The repository's size as GitHub reports it (`size`, in KiB): the packed history, before any clone. */
			const getRepositorySizeKib = Effect.fn("GithubAppClient.getRepositorySizeKib")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(config, token, repoBase(config, owner, repo))
				if (!isOk(response)) return yield* failure(response, "Get repository", "repository")
				const json = yield* parseJson(response, "Get repository")
				return yield* decodeRepositorySize(json).pipe(
					Effect.mapBoth({
						onSuccess: (body) => body.size,
						onFailure: (cause) =>
							new GithubAppError({ message: "Unexpected repository payload", cause }),
					}),
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
				const response = yield* send({
					method: "POST",
					url: `${config.apiBaseUrl}/app/installations/${externalInstallationId}/access_tokens`,
					auth: VendorHttp.bearer(jwt),
					body: { repositories: [repo], permissions: { contents: "read", metadata: "read" } },
					errorMessage: "Scoped installation token request failed",
				})
				if (!isOk(response))
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
				head?: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const params = new URLSearchParams({
					...(head === undefined ? { state: "all" } : { state: "open", head }),
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
				if (!isOk(response)) return yield* failure(response, "List pull requests", "repository")
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
				if (statusOf(response) === 404) return null
				if (!isOk(response)) return yield* failure(response, "Get pull request", "repository")
				const json = yield* parseJson(response, "Get pull request")
				return yield* decodePullRequest(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected pull request payload", cause }),
					),
				)
			})

			/** A write is sent once (a DELETE may repeat); `retry` marks a POST that only reads, like a GraphQL query. */
			const authedSend = (
				method: "POST" | "PATCH" | "DELETE",
				token: string,
				url: string,
				body: unknown,
				context: string,
				retry?: boolean,
			) =>
				tokenCall(
					token,
					{
						method,
						url,
						...(body === undefined ? undefined : { body }),
						...(retry === undefined ? undefined : { retry }),
						errorMessage: `${context} failed`,
					},
					// A renamed repository answers a write with a same-origin redirect; method and body go along.
					true,
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
				const { items } = yield* collectPages(MAX_PR_FILE_PAGES, (page) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							token,
							`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls/${number}/files?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response))
							return yield* failure(response, "List pull request files", "repository")
						const json = yield* parseJson(response, "List pull request files")
						return yield* decodePullRequestFiles(json).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({
										message: "Unexpected pull request files payload",
										cause,
									}),
							),
						)
					}),
				)
				return items
			})

			// One page of each: the reviewer wants the recent story, not the archive. Checks come
			// from the pull request's head. The App's own comments are left out, so the
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
					if (!isOk(response)) return yield* failure(response, context, "repository")
					return yield* parseJson(response, context)
				})
				const unexpected = (what: string) => (cause: unknown) =>
					new GithubAppError({ message: `Unexpected ${what} payload`, cause })
				const pullRequestCommitsJson = yield* getJson(
					`${base}/pulls/${number}/commits?per_page=${PER_PAGE}`,
					"List pull request commits",
				)
				const commits = yield* decodePullRequestCommits(pullRequestCommitsJson).pipe(
					Effect.mapError(unexpected("pull request commits")),
				)
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
				const allComments = [
					...(yield* decodeDiscussionComments(inline).pipe(
						Effect.mapError(unexpected("review comments")),
					)),
					...(yield* decodeDiscussionComments(conversation).pipe(
						Effect.mapError(unexpected("comments")),
					)),
				]
				const comments = Arr.filter(allComments, notOwn)
				// The commits list is oldest first and one page long; the head is the pull request's own.
				const pullRequestHeadJson = yield* getJson(`${base}/pulls/${number}`, "Get pull request")
				const head = (yield* decodePullRequestHead(pullRequestHeadJson).pipe(
					Effect.mapError(unexpected("pull request")),
				)).head.sha
				const checkRunListJson = yield* getJson(
					`${base}/commits/${head}/check-runs?per_page=${PER_PAGE}`,
					"List check runs",
				)
				const checks = Arr.filter(
					(yield* decodeCheckRunList(checkRunListJson).pipe(
						Effect.mapError(unexpected("check runs")),
					)).check_runs,
					(check) => String(check.app?.id ?? "") !== config.appId,
				)
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
					// A query reads only, so a passing 5xx may send it again; a mutation is sent once.
					Str.startsWith("query")(Str.trim(query)),
				)
				if (!isOk(response)) return yield* failure(response, context, "repository")
				return yield* parseJson(response, context)
			})

			const graphqlFailure = (context: string, errors: ReadonlyArray<{ readonly message: string }>) =>
				new GithubAppError({
					message: `${context} failed: ${Str.slice(
						0,
						300,
					)(
						Arr.join(
							Arr.map(errors, (error) => error.message),
							"; ",
						),
					)}`,
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

			/**
			 * Hide this App's earlier comments that start with `prefix` as outdated, all but the one
			 * carrying `keep`. Already hidden ones are skipped, so a push costs one call per newly
			 * outdated comment. Answers how many it hid.
			 */
			const minimizeEarlierComments = Effect.fn("GithubAppClient.minimizeEarlierComments")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				prefix: string,
				keep: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
				const earlier = yield* Stream.paginate(1, (page: number) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							token,
							`${base}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response))
							return yield* failure(response, "List pull request comments", "repository")
						const issueCommentListJson = yield* parseJson(response, "List pull request comments")
						const comments = yield* decodeIssueCommentList(issueCommentListJson).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected comments payload", cause }),
							),
						)
						const more = comments.length >= PER_PAGE && page < MAX_COMMENT_PAGES
						return [comments, more ? Option.some(page + 1) : Option.none<number>()] as const
					}),
				).pipe(
					Stream.filter(
						(comment) =>
							String(comment.performed_via_github_app?.id ?? "") === config.appId &&
							Str.startsWith(prefix)(comment.body ?? "") &&
							!Str.includes(keep)(comment.body ?? ""),
					),
					Stream.runCollect,
				)
				const ids = Arr.flatMap(earlier, (comment) =>
					comment.node_id === undefined ? [] : [comment.node_id],
				)
				if (ids.length === 0) return 0
				// `nodes(ids:)` takes at most 100 ids a query.
				const shown = yield* Effect.forEach(Arr.chunksOf(ids, 100), (chunk) =>
					Effect.gen(function* () {
						const commentStatesJson = yield* graphql(
							externalInstallationId,
							COMMENT_STATES_QUERY,
							{ ids: chunk },
							"Read comment states",
						)
						const states = yield* decodeCommentStates(commentStatesJson).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({
										message: "Unexpected comment states payload",
										cause,
									}),
							),
						)
						if (states.errors && states.errors.length > 0)
							return yield* graphqlFailure("Read comment states", states.errors)
						return Arr.flatMap(states.data?.nodes ?? [], (node) =>
							node?.id !== undefined && node.isMinimized === false ? [node.id] : [],
						)
					}),
				).pipe(Effect.map((pages) => pages.flat()))
				yield* Effect.forEach(
					shown,
					(id) =>
						Effect.gen(function* () {
							const mutationJson = yield* graphql(
								externalInstallationId,
								MINIMIZE_COMMENT_MUTATION,
								{ id },
								"Minimize comment",
							)
							const decoded = yield* decodeMutation(mutationJson).pipe(
								Effect.mapError(
									(cause) =>
										new GithubAppError({ message: "Unexpected mutation payload", cause }),
								),
							)
							if (decoded.errors && decoded.errors.length > 0)
								return yield* graphqlFailure("Minimize comment", decoded.errors)
						}),
					{ discard: true },
				)
				return shown.length
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
				if (!isOk(response)) return yield* failure(response, "List review comments", "repository")
				const reviewCommentListJson = yield* parseJson(response, "List review comments")
				return yield* decodeReviewCommentList(reviewCommentListJson).pipe(
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
				if (!isOk(response)) return yield* failure(response, "Reply to review comment", "repository")
				const createdCommentJson = yield* parseJson(response, "Reply to review comment")
				return yield* decodeCreatedComment(createdCommentJson).pipe(
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
					if (!isOk(response)) return yield* failure(response, context, "repository")
					const payloadJson = yield* parseJson(response, context)
					return yield* Schema.decodeEffect(schema)(payloadJson).pipe(
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
				if (!isOk(response)) return yield* failure(response, "Get pull request", "repository")
				const pullRequestHeadJson = yield* parseJson(response, "Get pull request")
				return yield* decodePullRequestHead(pullRequestHeadJson).pipe(
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
				if (!isOk(response)) return yield* failure(response, "Add reaction", "repository")
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
					if (statusOf(response) === 404) return "none"
					if (!isOk(response))
						return yield* failure(response, "Get collaborator permission", "repository")
					const collaboratorPermissionJson = yield* parseJson(
						response,
						"Get collaborator permission",
					)
					const decoded = yield* decodeCollaboratorPermission(collaboratorPermissionJson).pipe(
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
				if (!isOk(parentResponse))
					return yield* failure(parentResponse, "Read parent commit", "repository")
				const gitCommitJson = yield* parseJson(parentResponse, "Read parent commit")
				const parent = yield* decodeGitCommit(gitCommitJson).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected commit payload", cause }),
					),
				)
				// An edited file keeps its mode (an executable stays executable); only a new file is
				// 100644. Walked one directory at a time, since a recursive listing truncates.
				const trees = new Map<string, Schema.Schema.Type<typeof GithubApiGitTreeListing>["tree"]>()
				const listTree = Effect.fnUntraced(function* (sha: string) {
					const cached = trees.get(sha)
					if (cached !== undefined) return cached
					const response = yield* authedGet(config, token, `${base}/git/trees/${sha}`)
					if (!isOk(response)) return yield* failure(response, "Read tree", "repository")
					const gitTreeListingJson = yield* parseJson(response, "Read tree")
					const listing = yield* decodeGitTreeListing(gitTreeListingJson).pipe(
						Effect.mapError(
							(cause) => new GithubAppError({ message: "Unexpected tree payload", cause }),
						),
					)
					trees.set(sha, listing.tree)
					return listing.tree
				})
				const modeOf = (path: string) => {
					const parts = Str.split(path, "/")
					const descend = (i: number, sha: string): Effect.Effect<string, GithubAppError> => {
						const part = parts[i]
						if (part === undefined) return Effect.succeed("100644")
						return listTree(sha).pipe(
							Effect.flatMap((tree) => {
								const found = Arr.findFirst(tree, (candidate) => candidate.path === part)
								if (Option.isNone(found)) return Effect.succeed("100644")
								const entry = found.value
								if (i === parts.length - 1) {
									if (entry.mode !== "100644" && entry.mode !== "100755")
										return Effect.fail(
											new GithubAppError({
												message: `${path} is not a regular file (mode ${entry.mode}); it is not edited`,
												scope: "repository",
											}),
										)
									return Effect.succeed(entry.mode)
								}
								// A symlink or submodule in the middle of the path would be written through, or replaced.
								if (entry.type !== "tree")
									return Effect.fail(
										new GithubAppError({
											message: `${path} passes through ${Arr.join(parts.slice(0, i + 1), "/")}, which is not a directory (mode ${entry.mode}); it is not edited`,
											scope: "repository",
										}),
									)
								return descend(i + 1, entry.sha)
							}),
						)
					}
					return descend(0, parent.tree.sha)
				}
				const modes = yield* Effect.forEach(input.files, (file) => modeOf(file.path))
				const tree = yield* sendJson(
					externalInstallationId,
					"POST",
					() => `${base}/git/trees`,
					{
						base_tree: parent.tree.sha,
						tree: Arr.map(input.files, (file, i) => ({
							path: file.path,
							mode: modes[i] ?? "100644",
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
					`${base}/git/refs/heads/${Arr.join(
						Arr.map(Str.split(input.branch, "/"), (part) => encodeURIComponent(part)),
						"/",
					)}`,
					{ sha: commit.sha, force: false },
					"Update branch",
				)
				if (!isOk(refResponse)) return yield* failure(refResponse, "Update branch", "repository")
				return { sha: commit.sha, htmlUrl: commit.html_url ?? null }
			})

			/**
			 * A three-dot comparison: the files `head` changed since its merge base with `base`, and how
			 * the two commits relate. GitHub lists at most 300 files, on the first page only, so
			 * `truncated` says the list may be partial.
			 */
			const compareCommits = Effect.fn("GithubAppClient.compareCommits")(function* (
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
				if (!isOk(response)) return yield* failure(response, "Compare commits", "repository")
				const comparisonJson = yield* parseJson(response, "Compare commits")
				const decoded = yield* decodeComparison(comparisonJson).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected comparison payload", cause }),
					),
				)
				const files = decoded.files ?? []
				return { status: decoded.status, files, truncated: files.length >= MAX_COMPARE_FILES }
			})

			// Needs `checks: write` on the App. A 403 here is the installation not
			// having accepted that permission yet; the provider maps it to a
			// repository-scoped failure the review records as `publish_error`.
			// The App's own unfinished run of this name on the head is moved on rather than
			// duplicated, so a review shows as running in CI and then completes in place.
			const upsertCheckRun = Effect.fn("GithubAppClient.upsertCheckRun")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				input: GithubCheckRunInput,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
				const listed = yield* authedGet(
					config,
					token,
					`${base}/commits/${encodeURIComponent(input.headSha)}/check-runs?check_name=${encodeURIComponent(input.name)}&app_id=${encodeURIComponent(config.appId)}&filter=latest`,
				)
				if (!isOk(listed)) return yield* failure(listed, "List check runs", "repository")
				const ownCheckRunListJson = yield* parseJson(listed, "List check runs")
				const ownCheckRunList = yield* decodeOwnCheckRunList(ownCheckRunListJson).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({ message: "Unexpected check run list payload", cause }),
					),
				)
				const running = Option.getOrUndefined(
					Arr.findFirst(ownCheckRunList.check_runs, (run) => run.status !== "completed"),
				)
				yield* Effect.annotateCurrentSpan({
					"vcs.check_run.status": input.state.status,
					"vcs.check_run.updated": running !== undefined,
				})
				const output = {
					title: input.title,
					summary: input.summary,
					annotations: Arr.map(
						input.annotations.slice(0, CHECK_RUN_ANNOTATION_LIMIT),
						(annotation) => ({
							path: annotation.path,
							start_line: annotation.startLine,
							end_line: annotation.endLine,
							annotation_level: annotation.level,
							title: annotation.title,
							message: annotation.message,
						}),
					),
				}
				const state =
					input.state.status === "completed"
						? { status: "completed", conclusion: input.state.conclusion }
						: { status: "in_progress" }
				const response =
					running === undefined
						? yield* authedSend(
								"POST",
								token,
								`${base}/check-runs`,
								{ name: input.name, head_sha: input.headSha, ...state, output },
								"Create check run",
							)
						: yield* authedSend(
								"PATCH",
								token,
								`${base}/check-runs/${running.id}`,
								{ ...state, output },
								"Update check run",
							)
				if (!isOk(response)) return yield* failure(response, "Write check run", "repository")
				const json = yield* parseJson(response, "Write check run")
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
						comments: Arr.map(input.comments, (comment) => ({
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
				if (!isOk(response))
					return yield* failure(response, "Create pull request review", "repository")
				const json = yield* parseJson(response, "Create pull request review")
				return yield* decodeReview(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected review payload", cause }),
					),
				)
			})

			/**
			 * Create or edit the one comment carrying `marker`, so a later write with the same marker
			 * updates the same comment. Only a comment this App wrote is edited: a person who
			 * quoted the marker keeps their comment, and the App could not edit it anyway.
			 */
			const upsertIssueComment = Effect.fn("GithubAppClient.upsertIssueComment")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				number: number,
				marker: string,
				// A function writes from the comment already there, so a status line keeps what it sits on;
				// `undefined` from it leaves the comment alone (the result is whatever is there), `null` deletes it.
				body: string | ((existing: string | undefined) => string | null | undefined),
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const base = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
				// Read lazily: paging stops at the first page holding the marked comment.
				const found = yield* Stream.paginate(1, (page: number) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							token,
							`${base}/issues/${number}/comments?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response))
							return yield* failure(response, "List pull request comments", "repository")
						const issueCommentListJson = yield* parseJson(response, "List pull request comments")
						const comments = yield* decodeIssueCommentList(issueCommentListJson).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected comments payload", cause }),
							),
						)
						const match = Option.getOrUndefined(
							Arr.findFirst(
								comments,
								(comment) =>
									Str.includes(marker)(comment.body ?? "") &&
									String(comment.performed_via_github_app?.id ?? "") === config.appId,
							),
						)
						const more =
							match === undefined && comments.length >= PER_PAGE && page < MAX_COMMENT_PAGES
						return [
							match === undefined ? [] : [match],
							more ? Option.some(page + 1) : Option.none<number>(),
						] as const
					}),
				).pipe(Stream.runHead)
				const existing = Option.getOrUndefined(found)
				yield* Effect.annotateCurrentSpan("vcs.pull_request.comment_updated", existing !== undefined)
				const text = typeof body === "string" ? body : body(existing?.body ?? undefined)
				if (text === undefined) return existing
				if (text === null) {
					if (existing === undefined) return undefined
					const deleted = yield* authedSend(
						"DELETE",
						token,
						`${base}/issues/comments/${existing.id}`,
						undefined,
						"Delete comment",
					)
					// Already gone is what was asked for.
					if (!isOk(deleted) && statusOf(deleted) !== 404)
						return yield* failure(deleted, "Delete pull request comment", "repository")
					return undefined
				}
				const response =
					existing === undefined
						? yield* authedSend(
								"POST",
								token,
								`${base}/issues/${number}/comments`,
								{ body: text },
								"Create comment",
							)
						: yield* authedSend(
								"PATCH",
								token,
								`${base}/issues/comments/${existing.id}`,
								{ body: text },
								"Update comment",
							)
				if (!isOk(response))
					return yield* failure(response, "Write pull request comment", "repository")
				const issueCommentJson = yield* parseJson(response, "Write pull request comment")
				return yield* decodeIssueComment(issueCommentJson).pipe(
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
				const query = Arr.join(
					Arr.filter(
						[queryText, `repo:${owner}/${repo}`, path ? `path:${path}` : undefined],
						(part): part is string => part !== undefined,
					),
					" ",
				)
				const params = new URLSearchParams({ q: query, per_page: String(limit), page: "1" })
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/search/code?${params.toString()}`,
					"application/vnd.github.text-match+json",
				)
				if (!isOk(response)) return yield* failure(response, "Search code", "repository")
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
				const encodedPath = Arr.join(
					Arr.map(Str.split(path, "/"), (part) => encodeURIComponent(part)),
					"/",
				)
				const params = new URLSearchParams({ ref })
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}?${params.toString()}`,
				)
				// A path absent at that ref (rule files most repos lack, files a PR deletes) is none.
				if (statusOf(response) === 404) return Option.none<GithubContentFile>()
				if (!isOk(response)) return yield* failure(response, "Get repository file", "repository")
				const json = yield* parseJson(response, "Get repository file")
				return yield* decodeContentFile(json).pipe(
					Effect.mapBoth({
						onSuccess: Option.some,
						onFailure: (cause) =>
							new GithubAppError({ message: "Unexpected repository file payload", cause }),
					}),
				)
			})

			/** Every entry under a commit's tree in one call; GitHub truncates past 100,000 entries or 7 MB. */
			const getRecursiveTree = Effect.fn("GithubAppClient.getRecursiveTree")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				treeish: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const response = yield* authedGet(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeish)}?recursive=1`,
				)
				if (statusOf(response) === 404) {
					// GitHub 404s the recursive tree of a commit whose tree is git's empty tree.
					const commit = yield* authedGet(
						config,
						token,
						`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/commits/${encodeURIComponent(treeish)}`,
					)
					const treeSha = isOk(commit)
						? yield* parseJson(commit, "Read commit").pipe(
								Effect.flatMap(decodeGitCommit),
								Effect.map((decoded) => decoded.tree.sha),
								Effect.orElseSucceed(() => undefined),
							)
						: undefined
					if (treeSha === EMPTY_TREE_SHA)
						return {
							sha: EMPTY_TREE_SHA,
							truncated: false,
							tree: [],
						} satisfies GithubRecursiveTree
				}
				if (!isOk(response)) return yield* failure(response, "Read tree", "repository")
				const listing = yield* decodeTreeResponse(response)
				if (!listing.truncated) return listing
				// Too large for one read (a monorepo): list it again subtree by subtree.
				const walked = yield* walkTree(
					config,
					token,
					`${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
					listing.sha,
				)
				yield* Effect.annotateCurrentSpan({
					"maple.github.tree_walk.reads": walked.reads,
					"maple.github.tree_walk.truncated": walked.truncated,
				})
				return {
					sha: listing.sha,
					truncated: walked.truncated,
					tree: walked.tree,
				} satisfies GithubRecursiveTree
			})

			const decodeTreeResponse = (response: GithubAnswer) =>
				parseJson(response, "Read tree").pipe(
					Effect.flatMap((json) =>
						decodeRecursiveTree(json).pipe(
							Effect.mapError(
								(cause) => new GithubAppError({ message: "Unexpected tree payload", cause }),
							),
						),
					),
				)

			/**
			 * A tree GitHub truncates, read as its direct entries plus one recursive read per subtree,
			 * descending further only into a subtree that is itself truncated. Bounded in reads and
			 * entries; past either bound the listing is reported truncated, never as complete.
			 */
			const walkTree = Effect.fnUntraced(function* (
				config: ResolvedAppConfig,
				token: string,
				base: string,
				rootSha: string,
			) {
				const reads = yield* Ref.make(0)
				const entries = yield* Ref.make(0)
				// One gate for the whole walk: nested walks would otherwise multiply the reads in flight.
				// A read never recurses, so holding its permit cannot starve a nested one.
				const gate = yield* Semaphore.make(TREE_WALK_CONCURRENCY)
				const readOnce = Effect.fnUntraced(function* (sha: string, recursive: boolean) {
					const count = yield* Ref.updateAndGet(reads, (n) => n + 1)
					if (count > MAX_TREE_WALK_READS) return Option.none<GithubRecursiveTree>()
					// Past the entry cap the answer is already truncated; spend no more reads on it.
					if ((yield* Ref.get(entries)) > MAX_TREE_WALK_ENTRIES)
						return Option.none<GithubRecursiveTree>()
					const response = yield* authedGet(
						config,
						token,
						`${base}/git/trees/${encodeURIComponent(sha)}${recursive ? "?recursive=1" : ""}`,
					)
					if (!isOk(response)) return yield* failure(response, "Read tree", "repository")
					const listing = yield* decodeTreeResponse(response)
					// A truncated recursive read is discarded and re-listed level by level, so it is not held.
					const held = recursive && listing.truncated ? 0 : listing.tree.length
					const total = yield* Ref.updateAndGet(entries, (n) => n + held)
					return total > MAX_TREE_WALK_ENTRIES
						? Option.none<GithubRecursiveTree>()
						: Option.some(listing)
				})
				const read = (sha: string, recursive: boolean) =>
					readOnce(sha, recursive).pipe(gate.withPermit)
				type Walked = { readonly tree: GithubRecursiveTree["tree"]; readonly truncated: boolean }
				const under = (prefix: string, walked: Walked): Walked => ({
					truncated: walked.truncated,
					tree: Arr.map(walked.tree, (entry) => ({ ...entry, path: `${prefix}${entry.path}` })),
				})
				const cut: Walked = { tree: [], truncated: true }
				const walk = (sha: string): Effect.Effect<Walked, GithubAppError> =>
					read(sha, false).pipe(
						Effect.flatMap(
							Option.match({
								onNone: () => Effect.succeed(cut),
								onSome: (level) =>
									Effect.forEach(
										Arr.filter(level.tree, (entry) => entry.type === "tree"),
										(dir) =>
											read(dir.sha, true).pipe(
												Effect.flatMap(
													Option.match({
														onNone: () => Effect.succeed(cut),
														onSome: (sub) =>
															sub.truncated
																? walk(dir.sha)
																: Effect.succeed<Walked>({
																		tree: sub.tree,
																		truncated: false,
																	}),
													}),
												),
												Effect.map((walked) => under(`${dir.path}/`, walked)),
											),
										{ concurrency: TREE_WALK_CONCURRENCY },
									).pipe(
										Effect.map((subtrees): Walked => ({
											truncated:
												level.truncated || Arr.some(subtrees, (s) => s.truncated),
											tree: [...level.tree, ...Arr.flatMap(subtrees, (s) => s.tree)],
										})),
									),
							}),
						),
					)
				const walked = yield* walk(rootSha)
				const attempted = yield* Ref.get(reads)
				return { ...walked, reads: Math.min(attempted, MAX_TREE_WALK_READS) }
			})

			/**
			 * One blob's bytes as text, by its sha; unlike the contents API it serves files up to 100 MB.
			 * Read raw, so a large lockfile is never held as base64 JSON as well, and never past `maxBytes`.
			 */
			const getBlobText = Effect.fn("GithubAppClient.getBlobText")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				sha: string,
				maxBytes: number,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const url = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`
				const open = (path: string) =>
					githubHttp(tokenAuth(token), apiHeaders("application/vnd.github.raw+json"))
						.stream({ path })
						.pipe(
							Effect.map((blob) => ({ _tag: "Blob" as const, blob })),
							Effect.catch((error) =>
								answerOf(error, "Could not read the blob").pipe(
									Effect.tap((answer) => evictIfRejected(token, answer)),
									Effect.map((answer) => ({ _tag: "Refused" as const, answer })),
								),
							),
						)
				const first = yield* open(url)
				// A renamed repository redirects within the API host; follow it once with the token.
				const next = first._tag === "Refused" ? sameOriginRedirect(first.answer, url) : undefined
				const result = next === undefined ? first : yield* open(next)
				if (result._tag === "Refused") return yield* failure(result.answer, "Read blob", "repository")
				const blob = result.blob
				return yield* readTextWithin(
					blob.body.pipe(
						Stream.mapError(
							(cause) => new GithubAppError({ message: "Could not read the blob", cause }),
						),
					),
					maxBytes,
					() => new GithubAppError({ message: `The blob is larger than ${maxBytes} bytes` }),
				)
			})

			// An Actions job id is its check run id. Reading annotations needs only `checks: read`,
			// which the App's `checks: write` covers. Paging stops at the first page holding a failure:
			// that is what CI traces want, and warnings before it should not hide it.
			const listCheckRunAnnotations = Effect.fn("GithubAppClient.listCheckRunAnnotations")(function* (
				externalInstallationId: string,
				owner: string,
				repo: string,
				checkRunId: string,
			) {
				const config = yield* resolveConfig
				const token = yield* mintInstallationToken(externalInstallationId)
				const url = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/check-runs/${encodeURIComponent(checkRunId)}/annotations`
				const pages = yield* Stream.paginate(1, (page: number) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							token,
							`${url}?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response))
							return yield* failure(response, "List check run annotations", "repository")
						const checkRunAnnotationsJson = yield* parseJson(
							response,
							"List check run annotations",
						)
						const annotations = yield* decodeCheckRunAnnotations(checkRunAnnotationsJson).pipe(
							Effect.mapError(
								(cause) =>
									new GithubAppError({ message: "Unexpected annotations payload", cause }),
							),
						)
						const more =
							annotations.length >= PER_PAGE &&
							page < MAX_ANNOTATION_PAGES &&
							!Arr.some(annotations, (annotation) => annotation.annotation_level === "failure")
						return [[annotations], more ? Option.some(page + 1) : Option.none<number>()] as const
					}),
				).pipe(Stream.runCollect)
				return pages.flat()
			})

			// An Actions job's log as text lines, read as it downloads so a long log never sits in
			// memory and a caller that stops early stops the download. Needs `actions: read`
			// (`canReadActions`). GitHub redirects to a short-lived signed URL on
			// another host; the redirect is followed by hand so the installation token is not sent there.
			const streamJobLog = (
				externalInstallationId: string,
				owner: string,
				repo: string,
				jobId: string,
			): Stream.Stream<string, GithubAppError> =>
				Stream.unwrap(
					Effect.gen(function* () {
						const config = yield* resolveConfig
						const token = yield* mintInstallationToken(externalInstallationId)
						const url = `${config.apiBaseUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/actions/jobs/${encodeURIComponent(jobId)}/logs`
						const downloadUrl = yield* tokenCall(
							token,
							{ url, errorMessage: "Get job log request failed" },
							// Follows only a same-origin rename; the signed download URL is another host's.
							true,
						).pipe(
							Effect.flatMap((response) =>
								!response.ok &&
								response.location !== undefined &&
								REDIRECT_STATUSES.has(response.status)
									? Effect.succeed(response.location)
									: failure(response, "Get job log", "repository"),
							),
							Effect.retry({
								while: (error) => error.status === 404,
								schedule: Schedule.exponential(JOB_LOG_NOT_READY_BACKOFF),
								times: JOB_LOG_NOT_READY_RETRIES,
							}),
						)
						// The signed URL carries its own credential: no token, and only the user agent.
						const download = yield* githubHttp(
							VendorHttp.noAuth,
							{ "user-agent": USER_AGENT },
							// The log store's 503 (`ServerBusy`) passes.
							Schedule.max([
								Schedule.exponential(JOB_LOG_BUSY_BACKOFF),
								Schedule.recurs(JOB_LOG_BUSY_RETRIES),
							]),
						)
							.stream({ path: downloadUrl })
							.pipe(
								Effect.map((log) => Option.some(log.body)),
								Effect.catch((error) =>
									error.status === 404
										? Effect.succeed(
												Option.none<
													Stream.Stream<Uint8Array, VendorHttp.VendorHttpError>
												>(),
											)
										: answerOf(error, "GitHub job log download failed").pipe(
												Effect.flatMap((answer) =>
													failure(answer, "Download job log", "repository"),
												),
											),
								),
							)
						// A 404 from the log store is a log past retention: nothing to read, not a failure.
						if (Option.isNone(download)) {
							yield* Effect.annotateCurrentSpan("maple.cicd.job_log", "expired")
							return Stream.empty
						}
						return download.value.pipe(
							Stream.mapError(
								(cause) =>
									new GithubAppError({ message: "GitHub job log download failed", cause }),
							),
							Stream.decodeText,
							Stream.splitLines,
						)
					}),
				).pipe(
					Stream.withSpan("GithubAppClient.streamJobLog", {
						attributes: { "cicd.pipeline.task.run.id": jobId },
					}),
				)

			// Used by the dashboard connect flow to populate the installation row.
			const getInstallation = Effect.fn("GithubAppClient.getInstallation")(function* (
				externalInstallationId: string,
			) {
				const config = yield* resolveConfig
				const jwt = yield* mintAppJwt(config)
				const response = yield* send({
					url: `${config.apiBaseUrl}/app/installations/${externalInstallationId}`,
					auth: VendorHttp.bearer(jwt),
					errorMessage: "Get installation request failed",
				})
				if (!isOk(response)) return yield* failure(response, "Get installation", "installation")
				const json = yield* parseJson(response, "Get installation")
				return yield* decodeInstallationDetail(json).pipe(
					Effect.mapError(
						(cause) => new GithubAppError({ message: "Unexpected installation payload", cause }),
					),
				)
			})

			// The two calls below prove the user owns the installation they're connecting.

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
				// A POST, so never retried: a code is good for one exchange. The client
				// credentials and the code travel as the form body, as GitHub documents.
				const response = yield* githubHttp(
					(request) =>
						HttpClientRequest.bodyUrlParams(request, {
							client_id: clientId,
							client_secret: Redacted.value(clientSecret),
							code,
						}),
					{ accept: "application/json", "user-agent": USER_AGENT },
				)
					.text({
						method: "POST",
						path: `${githubWebBaseUrl(env.GITHUB_API_BASE_URL)}/login/oauth/access_token`,
					})
					.pipe(
						Effect.map((body): GithubAnswer => ({ ok: true, body })),
						Effect.catch((error) => answerOf(error, "GitHub OAuth code exchange failed")),
					)
				if (!isOk(response)) return yield* failure(response, "GitHub OAuth code exchange")
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
				const { items } = yield* collectPages(MAX_PAGES, (page) =>
					Effect.gen(function* () {
						const response = yield* authedGet(
							config,
							userAccessToken,
							`${config.apiBaseUrl}/user/installations?per_page=${PER_PAGE}&page=${page}`,
						)
						if (!isOk(response)) return yield* failure(response, "List user installations")
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
						return decoded.installations
					}),
				)
				return new Set(Arr.map(items, (installation) => String(installation.id)))
			})

			// Org accounts need an active `admin` membership (a 403 means the App lacks Members: read,
			// so it is "unverifiable"); a user account must be the authenticated user.
			const checkAccountAdmin = Effect.fn("GithubAppClient.checkAccountAdmin")(function* (
				userAccessToken: string,
				account: { readonly type: string; readonly id: number; readonly login: string },
			) {
				const config = yield* resolveConfig
				if (account.type !== "Organization") {
					const response = yield* authedGet(config, userAccessToken, `${config.apiBaseUrl}/user`)
					if (!isOk(response)) return yield* failure(response, "Get authenticated user")
					const json = yield* parseJson(response, "Get authenticated user")
					const user = yield* decodeAuthenticatedUser(json).pipe(
						Effect.mapError(
							(cause) =>
								new GithubAppError({
									message: "Unexpected authenticated user payload",
									cause,
								}),
						),
					)
					const verdict: GithubAccountAdminCheck = user.id === account.id ? "admin" : "not-admin"
					return verdict
				}
				const response = yield* authedGet(
					config,
					userAccessToken,
					`${config.apiBaseUrl}/user/memberships/orgs/${encodeURIComponent(account.login)}`,
				)
				if (statusOf(response) === 404) return "not-admin" satisfies GithubAccountAdminCheck
				if (statusOf(response) === 403) return "unverifiable" satisfies GithubAccountAdminCheck
				if (!isOk(response)) return yield* failure(response, "Get organization membership")
				const json = yield* parseJson(response, "Get organization membership")
				const membership = yield* decodeOrgMembership(json).pipe(
					Effect.mapError(
						(cause) =>
							new GithubAppError({
								message: "Unexpected organization membership payload",
								cause,
							}),
					),
				)
				const verdict: GithubAccountAdminCheck =
					membership.state === "active" && membership.role === "admin" ? "admin" : "not-admin"
				return verdict
			})

			return {
				mintInstallationToken,
				checkAccountAdmin,
				listInstallationRepositories,
				listBranches,
				listCommits,
				getCommit,
				getRepositorySizeKib,
				listPullRequests,
				getPullRequest,
				listPullRequestFiles,
				getPullRequestContext,
				listReviewThreads,
				resolveReviewThread,
				minimizeEarlierComments,
				listReviewComments,
				replyToReviewComment,
				compareCommits,
				getPullRequestHead,
				createIssueComment,
				addCommentReaction,
				getCollaboratorPermission,
				commitFiles,
				upsertCheckRun,
				createPullRequestReview,
				upsertIssueComment,
				searchCode,
				getSourceFile,
				getRecursiveTree,
				getBlobText,
				listCheckRunAnnotations,
				streamJobLog,
				canReadActions,
				getOrganizationBillingUsage,
				mintCloneCredentials,
				getInstallation,
				exchangeUserOAuthCode,
				listUserInstallationIds,
			}
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
