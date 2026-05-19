import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"
import {
	IntegrationsForbiddenError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
} from "./integrations"

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

export class GithubApiGroup extends HttpApiGroup.make("github")
	.add(
		HttpApiEndpoint.get("githubStatus", "/status", {
			success: GithubIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("githubStart", "/start", {
			payload: GithubStartConnectRequest,
			success: GithubStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("githubListInstallations", "/installations", {
			success: GithubInstallationsListResponse,
			error: IntegrationsPersistenceError,
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
					IntegrationsNotConnectedError,
					IntegrationsValidationError,
					IntegrationsUpstreamError,
					IntegrationsPersistenceError,
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
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsPersistenceError,
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
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsPersistenceError,
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
				IntegrationsForbiddenError,
				IntegrationsNotConnectedError,
				IntegrationsPersistenceError,
				IntegrationsUpstreamError,
			],
		}),
	)
	.prefix("/api/integrations/github")
	.middleware(Authorization) {}
