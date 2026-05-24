import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

// --- Errors ---

// `code` on each error class is a stable, machine-readable identifier for the
// failure case. Required (not optional) so every throw site picks one
// explicitly — defeats the "always-undefined" trap of optional discriminators.
// The literal union doubles as inline documentation of the failure taxonomy:
// adding a new throw site forces an exhaustive list update in code review,
// and dashboards/alerts/traces filter on the stable code rather than parsing
// drift-prone message text.

export const GithubForbiddenErrorCode = Schema.Literals(["NotAdmin"])
export type GithubForbiddenErrorCode = Schema.Schema.Type<typeof GithubForbiddenErrorCode>

export class GithubForbiddenError extends Schema.TaggedErrorClass<GithubForbiddenError>()(
	"@maple/http/errors/GithubForbiddenError",
	{
		code: GithubForbiddenErrorCode,
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export const GithubValidationErrorCode = Schema.Literals([
	// Required GitHub App env var missing (appId, appSlug, privateKeyPem, webhookSecret).
	"MissingAppConfig",
	// Configured GITHUB_APP_PRIVATE_KEY can't be loaded as a valid PEM —
	// crypto.createPrivateKey / createSign threw. Operator needs to fix the env var.
	"InvalidPrivateKey",
	// OAuth install state token not found in DB (forged / stale / wrong-provider).
	"StateNotRecognized",
	// OAuth install state token past its TTL.
	"StateExpired",
	// `returnTo` URL parses to a different origin than the install request.
	"ReturnToCrossOrigin",
	// `x-hub-signature-256` header missing sha256= prefix or not valid hex.
	"WebhookSignatureMalformed",
	// HMAC key import from the configured webhook secret failed.
	"WebhookSecretImportFailed",
	// crypto.subtle.verify threw while comparing the signature.
	"WebhookSignatureVerifyFailed",
])
export type GithubValidationErrorCode = Schema.Schema.Type<typeof GithubValidationErrorCode>

export class GithubValidationError extends Schema.TaggedErrorClass<GithubValidationError>()(
	"@maple/http/errors/GithubValidationError",
	{
		code: GithubValidationErrorCode,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export const GithubNotConnectedErrorCode = Schema.Literals([
	// No installation row in our DB for this org+id.
	"InstallationNotFound",
	// No repository row in our DB for this org+id.
	"RepositoryNotFound",
])
export type GithubNotConnectedErrorCode = Schema.Schema.Type<typeof GithubNotConnectedErrorCode>

export class GithubNotConnectedError extends Schema.TaggedErrorClass<GithubNotConnectedError>()(
	"@maple/http/errors/GithubNotConnectedError",
	{
		code: GithubNotConnectedErrorCode,
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

export const GithubUpstreamErrorCode = Schema.Literals([
	// Network / fetch threw before getting a response from GitHub.
	"RequestFailed",
	// GitHub returned a non-2xx response.
	"Non2xx",
	// Response body couldn't be parsed as JSON.
	"ResponseNotJson",
	// JSON parsed but didn't match the expected schema.
	"ResponseSchemaMismatch",
	// Installation token response had an unparseable / non-finite expiry.
	"TokenInvalidExpiry",
])
export type GithubUpstreamErrorCode = Schema.Schema.Type<typeof GithubUpstreamErrorCode>

export class GithubUpstreamError extends Schema.TaggedErrorClass<GithubUpstreamError>()(
	"@maple/http/errors/GithubUpstreamError",
	{
		code: GithubUpstreamErrorCode,
		message: Schema.String,
		status: Schema.optional(Schema.Number),
	},
	{ httpApiStatus: 502 },
) {}

export const GithubPersistenceErrorCode = Schema.Literals([
	// Generic underlying DB error (DatabaseError from drizzle).
	"Database",
	// commit row's `branches_json` failed JSON/schema decode.
	"BranchesDecodeFailed",
	// installation row's enum fields (accountType / repositorySelection) failed decode.
	"InstallationRowDecodeFailed",
	// repository row's enum field (backfillStatus) failed decode.
	"RepositoryRowDecodeFailed",
	// Re-fetch immediately after insert returned no row — DB consistency issue.
	"InstallationMissingAfterInsert",
])
export type GithubPersistenceErrorCode = Schema.Schema.Type<typeof GithubPersistenceErrorCode>

export class GithubPersistenceError extends Schema.TaggedErrorClass<GithubPersistenceError>()(
	"@maple/http/errors/GithubPersistenceError",
	{
		code: GithubPersistenceErrorCode,
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export const GithubSyncQueueEnqueueErrorCode = Schema.Literals([
	// Cloudflare Queues rejected the publish (single or batch — `jobs.length`
	// disambiguates).
	"EnqueueFailed",
])
export type GithubSyncQueueEnqueueErrorCode = Schema.Schema.Type<
	typeof GithubSyncQueueEnqueueErrorCode
>

// Raised when publishing to the GitHub sync queue fails. The underlying
// Cloudflare Queues error rides in `cause` via Schema.Defect so the original
// failure propagates end-to-end (service → handler → wire → client) without
// stringifying through an `unknown`.
export class GithubSyncQueueEnqueueError extends Schema.TaggedErrorClass<GithubSyncQueueEnqueueError>()(
	"@maple/http/errors/GithubSyncQueueEnqueueError",
	{
		code: GithubSyncQueueEnqueueErrorCode,
		message: Schema.String,
		jobs: Schema.Array(Schema.String),
		cause: Schema.optionalKey(Schema.Defect),
	},
	{ httpApiStatus: 502 },
) {}

// --- Shared primitives ---

export const Sha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i)))

// --- GitHub integration types ---

export const GithubAccountType = Schema.Literals(["User", "Organization"]).annotate({
	identifier: "@maple/GithubAccountType",
})
export type GithubAccountType = Schema.Schema.Type<typeof GithubAccountType>

export const GithubRepositorySelection = Schema.Literals(["all", "selected"]).annotate({
	identifier: "@maple/GithubRepositorySelection",
})
export type GithubRepositorySelection = Schema.Schema.Type<typeof GithubRepositorySelection>

export const GithubBackfillStatus = Schema.Literals(["pending", "running", "complete", "failed"]).annotate({
	identifier: "@maple/GithubBackfillStatus",
})
export type GithubBackfillStatus = Schema.Schema.Type<typeof GithubBackfillStatus>

export class GithubIntegrationStatus extends Schema.Class<GithubIntegrationStatus>("GithubIntegrationStatus")({
	configured: Schema.Boolean,
	appSlug: Schema.NullOr(Schema.String),
	missingEnv: Schema.Array(Schema.String),
	installations: Schema.Number,
}) {}

export class GithubInstallationSummary extends Schema.Class<GithubInstallationSummary>(
	"GithubInstallationSummary",
)({
	id: Schema.String,
	installationId: Schema.Number,
	appSlug: Schema.String,
	accountId: Schema.Number,
	accountLogin: Schema.String,
	accountAvatarUrl: Schema.NullOr(Schema.String),
	accountType: GithubAccountType,
	repositorySelection: GithubRepositorySelection,
	suspendedAt: Schema.NullOr(Schema.Number),
	installedByUserId: Schema.String,
	createdAt: Schema.Number,
	updatedAt: Schema.Number,
	repositoryCount: Schema.Number,
}) {}

export class GithubInstallationsListResponse extends Schema.Class<GithubInstallationsListResponse>(
	"GithubInstallationsListResponse",
)({
	installations: Schema.Array(GithubInstallationSummary),
}) {}

export class GithubRepositorySummary extends Schema.Class<GithubRepositorySummary>("GithubRepositorySummary")({
	id: Schema.String,
	installationId: Schema.String,
	githubRepoId: Schema.Number,
	owner: Schema.String,
	name: Schema.String,
	defaultBranch: Schema.String,
	private: Schema.Boolean,
	htmlUrl: Schema.String,
	syncEnabled: Schema.Boolean,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastFullBackfillAt: Schema.NullOr(Schema.Number),
	backfillStatus: GithubBackfillStatus,
	backfillError: Schema.NullOr(Schema.String),
	commitCount: Schema.Number,
}) {}

export class GithubRepositoriesListResponse extends Schema.Class<GithubRepositoriesListResponse>(
	"GithubRepositoriesListResponse",
)({
	repositories: Schema.Array(GithubRepositorySummary),
}) {}

export class GithubStartConnectRequest extends Schema.Class<GithubStartConnectRequest>(
	"GithubStartConnectRequest",
)({
	returnTo: Schema.optional(Schema.String),
}) {}

export class GithubStartConnectResponse extends Schema.Class<GithubStartConnectResponse>(
	"GithubStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class GithubSetRepoSyncRequest extends Schema.Class<GithubSetRepoSyncRequest>(
	"GithubSetRepoSyncRequest",
)({
	enabled: Schema.Boolean,
}) {}

export class GithubSetRepoSyncResponse extends Schema.Class<GithubSetRepoSyncResponse>(
	"GithubSetRepoSyncResponse",
)({
	repositoryId: Schema.String,
	syncEnabled: Schema.Boolean,
}) {}

export class GithubBackfillRepoResponse extends Schema.Class<GithubBackfillRepoResponse>(
	"GithubBackfillRepoResponse",
)({
	repositoryId: Schema.String,
	enqueued: Schema.Boolean,
}) {}

export class GithubDisconnectResponse extends Schema.Class<GithubDisconnectResponse>(
	"GithubDisconnectResponse",
)({
	disconnected: Schema.Boolean,
	uninstallUrl: Schema.NullOr(Schema.String),
}) {}

// --- Commits feature types ---

export class CommitAuthor extends Schema.Class<CommitAuthor>("CommitAuthor")({
	login: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	avatarUrl: Schema.NullOr(Schema.String),
}) {}

export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
	sha: Sha,
	shortSha: Sha,
	message: Schema.String,
	htmlUrl: Schema.String,
	repoOwner: Schema.String,
	repoName: Schema.String,
	author: CommitAuthor,
	committer: CommitAuthor,
	authoredAt: Schema.Number,
	committedAt: Schema.Number,
	branches: Schema.Array(Schema.String),
	prNumber: Schema.NullOr(Schema.Number),
}) {}

export class CommitsLookupRequest extends Schema.Class<CommitsLookupRequest>("CommitsLookupRequest")({
	shas: Schema.Array(Sha),
}) {}

export class CommitsLookupEntry extends Schema.Class<CommitsLookupEntry>("CommitsLookupEntry")({
	sha: Sha,
	commit: Schema.NullOr(CommitInfo),
}) {}

export class CommitsLookupResponse extends Schema.Class<CommitsLookupResponse>("CommitsLookupResponse")({
	entries: Schema.Array(CommitsLookupEntry),
}) {}

export class CommitsResyncRequest extends Schema.Class<CommitsResyncRequest>("CommitsResyncRequest")({
	sha: Sha,
}) {}

export class CommitsResyncResponse extends Schema.Class<CommitsResyncResponse>("CommitsResyncResponse")({
	enqueued: Schema.Boolean,
}) {}

// --- API groups ---

export class GithubApiGroup extends HttpApiGroup.make("github")
	.add(
		HttpApiEndpoint.get("githubStatus", "/status", {
			success: GithubIntegrationStatus,
			error: GithubPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("githubStart", "/start", {
			payload: GithubStartConnectRequest,
			success: GithubStartConnectResponse,
			error: [GithubForbiddenError, GithubValidationError, GithubPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("githubListInstallations", "/installations", {
			success: GithubInstallationsListResponse,
			error: GithubPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.get(
			"githubListRepositories",
			"/installations/:installationId/repositories",
			{
				params: {
					installationId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
				},
				success: GithubRepositoriesListResponse,
				error: [
					GithubNotConnectedError,
					GithubValidationError,
					GithubUpstreamError,
					GithubPersistenceError,
				],
			},
		),
	)
	.add(
		HttpApiEndpoint.post("githubSetRepoSync", "/repositories/:repositoryId/sync", {
			payload: GithubSetRepoSyncRequest,
			params: {
				repositoryId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
			},
			success: GithubSetRepoSyncResponse,
			error: [
				GithubForbiddenError,
				GithubValidationError,
				GithubNotConnectedError,
				GithubPersistenceError,
				GithubSyncQueueEnqueueError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.post("githubBackfillRepo", "/repositories/:repositoryId/backfill", {
			params: {
				repositoryId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
			},
			success: GithubBackfillRepoResponse,
			error: [
				GithubForbiddenError,
				GithubNotConnectedError,
				GithubPersistenceError,
				GithubSyncQueueEnqueueError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDisconnect", "/installations/:installationId", {
			params: {
				installationId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
			},
			success: GithubDisconnectResponse,
			error: [
				GithubForbiddenError,
				GithubNotConnectedError,
				GithubPersistenceError,
				GithubUpstreamError,
			],
		}),
	)
	.prefix("/api/integrations/github")
	.middleware(Authorization) {}

export class CommitsApiGroup extends HttpApiGroup.make("commits")
	.add(
		HttpApiEndpoint.post("commitsLookupBySha", "/lookup", {
			payload: CommitsLookupRequest,
			success: CommitsLookupResponse,
			error: [GithubValidationError, GithubPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("commitsResync", "/resync", {
			payload: CommitsResyncRequest,
			success: CommitsResyncResponse,
			error: [GithubValidationError, GithubPersistenceError, GithubSyncQueueEnqueueError],
		}),
	)
	.prefix("/api/commits")
	.middleware(Authorization) {}
