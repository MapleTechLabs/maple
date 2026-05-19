import { Schema } from "effect"

export const GithubBackfillRepoJob = Schema.TaggedStruct("BackfillRepo", {
	orgId: Schema.String,
	repoId: Schema.String,
	sinceUnixMs: Schema.Number,
	cursor: Schema.NullOr(Schema.String),
})
export type GithubBackfillRepoJob = Schema.Schema.Type<typeof GithubBackfillRepoJob>

export const GithubSyncWebhookPushJob = Schema.TaggedStruct("SyncWebhookPush", {
	orgId: Schema.String,
	installationId: Schema.Number,
	owner: Schema.String,
	name: Schema.String,
	ref: Schema.String,
	before: Schema.String,
	after: Schema.String,
	forced: Schema.Boolean,
	commitShas: Schema.Array(Schema.String),
})
export type GithubSyncWebhookPushJob = Schema.Schema.Type<typeof GithubSyncWebhookPushJob>

export const GithubResolveUnknownShaJob = Schema.TaggedStruct("ResolveUnknownSha", {
	orgId: Schema.String,
	sha: Schema.String,
})
export type GithubResolveUnknownShaJob = Schema.Schema.Type<typeof GithubResolveUnknownShaJob>

export const GithubReconcileInstallationJob = Schema.TaggedStruct("ReconcileInstallation", {
	orgId: Schema.String,
	installationId: Schema.Number,
})
export type GithubReconcileInstallationJob = Schema.Schema.Type<typeof GithubReconcileInstallationJob>

export const GithubSyncJob = Schema.Union([
	GithubBackfillRepoJob,
	GithubSyncWebhookPushJob,
	GithubResolveUnknownShaJob,
	GithubReconcileInstallationJob,
])
export type GithubSyncJob = Schema.Schema.Type<typeof GithubSyncJob>

export const encodeGithubSyncJob = Schema.encodeUnknownEffect(GithubSyncJob)
export const decodeGithubSyncJob = Schema.decodeUnknownEffect(GithubSyncJob)
