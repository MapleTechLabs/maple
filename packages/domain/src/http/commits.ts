import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IntegrationsPersistenceError, IntegrationsValidationError } from "./integrations"

export const Sha = Schema.String.pipe(Schema.check(Schema.isPattern(/^[0-9a-f]{7,40}$/i)))

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

export class GithubSyncQueueEnqueueError extends Schema.TaggedErrorClass<GithubSyncQueueEnqueueError>()(
	"GithubSyncQueueEnqueueError",
	{
		message: Schema.String,
		// Tags of the jobs we tried to enqueue. Length 1 for a single enqueue,
		// length N for a batch — the call shape is not a different failure mode.
		jobs: Schema.Array(Schema.String),
		cause: Schema.optionalKey(Schema.Defect),
	},
) {}

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

export class CommitsApiGroup extends HttpApiGroup.make("commits")
	.add(
		HttpApiEndpoint.post("commitsLookupBySha", "/lookup", {
			payload: CommitsLookupRequest,
			success: CommitsLookupResponse,
			error: [IntegrationsValidationError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.post("commitsResync", "/resync", {
			payload: CommitsResyncRequest,
			success: CommitsResyncResponse,
			error: [IntegrationsValidationError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/api/commits")
	.middleware(Authorization) {}
