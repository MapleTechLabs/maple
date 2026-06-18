import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { ExternalUserId, UserId } from "../primitives"
import { Authorization } from "./current-tenant"
import {
	GitCommitSha,
	VcsAccountType,
	VcsCommitNotFoundError,
	VcsCommitShaInvalidError,
	VcsProviderId,
	VcsRepoSelection,
	VcsRepoStatus,
	VcsRepoSyncStatus,
	VcsRepositoryId,
} from "./vcs"

export class HazelIntegrationStatus extends Schema.Class<HazelIntegrationStatus>("HazelIntegrationStatus")({
	connected: Schema.Boolean,
	externalUserId: Schema.NullOr(ExternalUserId),
	externalUserEmail: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(UserId),
	scope: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationSummary extends Schema.Class<HazelOrganizationSummary>(
	"HazelOrganizationSummary",
)({
	id: Schema.String,
	name: Schema.String,
	slug: Schema.NullOr(Schema.String),
	logoUrl: Schema.NullOr(Schema.String),
}) {}

export class HazelOrganizationsListResponse extends Schema.Class<HazelOrganizationsListResponse>(
	"HazelOrganizationsListResponse",
)({
	organizations: Schema.Array(HazelOrganizationSummary),
}) {}

export const HazelChannelType = Schema.Literals(["public", "private"]).annotate({
	identifier: "@maple/HazelChannelType",
	title: "Hazel Channel Type",
})
export type HazelChannelType = Schema.Schema.Type<typeof HazelChannelType>

export class HazelChannelSummary extends Schema.Class<HazelChannelSummary>("HazelChannelSummary")({
	id: Schema.String,
	name: Schema.String,
	type: HazelChannelType,
	organizationId: Schema.String,
}) {}

export class HazelChannelsListResponse extends Schema.Class<HazelChannelsListResponse>(
	"HazelChannelsListResponse",
)({
	channels: Schema.Array(HazelChannelSummary),
}) {}

export class HazelStartConnectRequest extends Schema.Class<HazelStartConnectRequest>(
	"HazelStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class HazelStartConnectResponse extends Schema.Class<HazelStartConnectResponse>(
	"HazelStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class HazelDisconnectResponse extends Schema.Class<HazelDisconnectResponse>("HazelDisconnectResponse")(
	{
		disconnected: Schema.Boolean,
	},
) {}

// ---- GitHub (VCS App installation) ----------------------------------------

/** One branch a repo knows about — an option in the tracked-branch picker. */
export class GithubBranchSummary extends Schema.Class<GithubBranchSummary>("GithubBranchSummary")({
	name: Schema.String,
	isDefault: Schema.Boolean,
}) {}

/** One synced repository, surfaced read-only so the dashboard can watch backfill. */
export class GithubRepoSummary extends Schema.Class<GithubRepoSummary>("GithubRepoSummary")({
	// Maple's own repository id (the `vcs_repositories` row) — the stable handle the
	// dashboard passes back to delete-from-Maple. The provider's `externalRepoId`
	// stays an internal sync detail and is deliberately not surfaced here.
	id: VcsRepositoryId,
	fullName: Schema.String,
	htmlUrl: Schema.String,
	isPrivate: Schema.Boolean,
	// Access lifecycle: "active" or "removed" (provider revoked access — the
	// dashboard prompts the user to re-enable in GitHub, or delete from Maple).
	status: VcsRepoStatus,
	syncStatus: VcsRepoSyncStatus,
	lastSyncedAt: Schema.NullOr(Schema.Number),
	lastSyncError: Schema.NullOr(Schema.String),
	// The single branch this repo tracks (only its commits are synced). Falls back
	// to the default branch for a legacy row whose tracked branch was never set.
	trackedBranch: Schema.NullOr(Schema.String),
	// All branches the repo knows about (names only) — the picker's options.
	branches: Schema.Array(GithubBranchSummary),
}) {}

export class GithubIntegrationStatus extends Schema.Class<GithubIntegrationStatus>("GithubIntegrationStatus")({
	connected: Schema.Boolean,
	accountLogin: Schema.NullOr(Schema.String),
	accountType: Schema.NullOr(VcsAccountType),
	repositorySelection: Schema.NullOr(VcsRepoSelection),
	repositories: Schema.Array(GithubRepoSummary),
}) {}

export class GithubStartConnectRequest extends Schema.Class<GithubStartConnectRequest>(
	"GithubStartConnectRequest",
)({
	returnTo: Schema.optionalKey(Schema.String),
}) {}

export class GithubStartConnectResponse extends Schema.Class<GithubStartConnectResponse>(
	"GithubStartConnectResponse",
)({
	redirectUrl: Schema.String,
	state: Schema.String,
}) {}

export class GithubDisconnectResponse extends Schema.Class<GithubDisconnectResponse>(
	"GithubDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

export class GithubDeleteRepositoryResponse extends Schema.Class<GithubDeleteRepositoryResponse>(
	"GithubDeleteRepositoryResponse",
)({
	deleted: Schema.Boolean,
}) {}

export class GithubSetTrackedBranchRequest extends Schema.Class<GithubSetTrackedBranchRequest>(
	"GithubSetTrackedBranchRequest",
)({
	// The single branch to track. Must be one the repo knows about. Changing it
	// wipes the repo's stored commits and re-backfills the new branch.
	trackedBranch: Schema.String,
}) {}

export class GithubSetTrackedBranchResponse extends Schema.Class<GithubSetTrackedBranchResponse>(
	"GithubSetTrackedBranchResponse",
)({
	trackedBranch: Schema.String,
	// True when the change enqueued a historical backfill of the new branch.
	backfillQueued: Schema.Boolean,
}) {}

// ---- Commit hover cards (vendor-agnostic) ---------------------------------

/**
 * A single resolved commit, for the dashboard's commit-SHA hover card. Provider-
 * neutral: any connected VCS provider resolves into this same shape. `resolved`
 * distinguishes a DB hit ("stored") from an on-the-fly provider fetch ("fetched")
 * — purely diagnostic.
 */
export class VcsCommitDetailResponse extends Schema.Class<VcsCommitDetailResponse>("VcsCommitDetailResponse")({
	provider: VcsProviderId,
	sha: GitCommitSha,
	message: Schema.String,
	authorName: Schema.NullOr(Schema.String),
	authorEmail: Schema.NullOr(Schema.String),
	authorLogin: Schema.NullOr(Schema.String),
	authorAvatarUrl: Schema.NullOr(Schema.String),
	authoredAt: Schema.NullOr(Schema.Number),
	committedAt: Schema.Number,
	htmlUrl: Schema.String,
	repoFullName: Schema.String,
	resolved: Schema.Literals(["stored", "fetched"]),
}) {}

export class IntegrationsForbiddenError extends Schema.TaggedErrorClass<IntegrationsForbiddenError>()(
	"@maple/http/errors/IntegrationsForbiddenError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 403 },
) {}

export class IntegrationsValidationError extends Schema.TaggedErrorClass<IntegrationsValidationError>()(
	"@maple/http/errors/IntegrationsValidationError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class IntegrationsNotConnectedError extends Schema.TaggedErrorClass<IntegrationsNotConnectedError>()(
	"@maple/http/errors/IntegrationsNotConnectedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 409 },
) {}

export class IntegrationsRevokedError extends Schema.TaggedErrorClass<IntegrationsRevokedError>()(
	"@maple/http/errors/IntegrationsRevokedError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 401 },
) {}

export class IntegrationsUpstreamError extends Schema.TaggedErrorClass<IntegrationsUpstreamError>()(
	"@maple/http/errors/IntegrationsUpstreamError",
	{
		message: Schema.String,
		status: Schema.optional(Schema.Number),
		cause: Schema.optionalKey(Schema.Defect),
	},
	{ httpApiStatus: 502 },
) {}

export class IntegrationsPersistenceError extends Schema.TaggedErrorClass<IntegrationsPersistenceError>()(
	"@maple/http/errors/IntegrationsPersistenceError",
	{
		message: Schema.String,
	},
	{ httpApiStatus: 503 },
) {}

export class IntegrationsApiGroup extends HttpApiGroup.make("integrations")
	.add(
		HttpApiEndpoint.get("hazelStatus", "/hazel/status", {
			success: HazelIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("hazelStart", "/hazel/start", {
			payload: HazelStartConnectRequest,
			success: HazelStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelOrganizations", "/hazel/organizations", {
			success: HazelOrganizationsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.get("hazelChannels", "/hazel/organizations/:organizationId/channels", {
			params: {
				organizationId: Schema.String.check(Schema.isMinLength(1), Schema.isTrimmed()),
			},
			success: HazelChannelsListResponse,
			error: [
				IntegrationsValidationError,
				IntegrationsNotConnectedError,
				IntegrationsRevokedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("hazelDisconnect", "/hazel", {
			success: HazelDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.get("githubStatus", "/github/status", {
			success: GithubIntegrationStatus,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.post("githubStart", "/github/start", {
			payload: GithubStartConnectRequest,
			success: GithubStartConnectResponse,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDisconnect", "/github", {
			success: GithubDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDeleteRepository", "/github/repositories/:repositoryId", {
			params: {
				repositoryId: VcsRepositoryId,
			},
			success: GithubDeleteRepositoryResponse,
			// Validation: a repo can only be deleted once its provider access was
			// removed (status "removed"); deleting an active repo is rejected (400).
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.put(
			"githubSetTrackedBranch",
			"/github/repositories/:repositoryId/tracked-branch",
			{
				params: {
					repositoryId: VcsRepositoryId,
				},
				payload: GithubSetTrackedBranchRequest,
				success: GithubSetTrackedBranchResponse,
				error: [
					IntegrationsForbiddenError,
					IntegrationsValidationError,
					IntegrationsPersistenceError,
				],
			},
		),
	)
	.add(
		// Vendor-neutral: resolves a commit by SHA across whatever providers the
		// org has connected. The `:sha` param is a raw string (NOT the strict
		// `GitCommitSha` brand) on purpose — it carries unguarded telemetry values,
		// so a non-40-hex SHA must reach the handler to become a typed
		// VcsCommitShaInvalidError rather than a generic decode 400. Read-only and
		// available to any org member (no admin gate) — every dashboard viewer
		// hovers commit SHAs.
		HttpApiEndpoint.get("vcsCommitDetail", "/vcs/commits/:sha", {
			params: {
				sha: Schema.String.check(Schema.isMinLength(1)),
			},
			success: VcsCommitDetailResponse,
			error: [
				VcsCommitShaInvalidError,
				VcsCommitNotFoundError,
				IntegrationsNotConnectedError,
				IntegrationsUpstreamError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.prefix("/api/integrations")
	.middleware(Authorization) {}
