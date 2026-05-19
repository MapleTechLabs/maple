import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import { IntegrationsPersistenceError, IntegrationsValidationError } from "./integrations"

export class CommitAuthor extends Schema.Class<CommitAuthor>("CommitAuthor")({
	login: Schema.NullOr(Schema.String),
	name: Schema.NullOr(Schema.String),
	email: Schema.NullOr(Schema.String),
	avatarUrl: Schema.NullOr(Schema.String),
}) {}

export class CommitInfo extends Schema.Class<CommitInfo>("CommitInfo")({
	sha: Schema.String,
	shortSha: Schema.String,
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
	shas: Schema.Array(Schema.String).pipe(Schema.check(Schema.isMaxLength(200))),
}) {}

export class CommitsLookupEntry extends Schema.Class<CommitsLookupEntry>("CommitsLookupEntry")({
	sha: Schema.String,
	commit: Schema.NullOr(CommitInfo),
}) {}

export class CommitsLookupResponse extends Schema.Class<CommitsLookupResponse>("CommitsLookupResponse")({
	entries: Schema.Array(CommitsLookupEntry),
}) {}

export class CommitsResyncRequest extends Schema.Class<CommitsResyncRequest>("CommitsResyncRequest")({
	sha: Schema.optional(Schema.String),
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
