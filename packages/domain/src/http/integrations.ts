import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { Authorization } from "./current-tenant"

export class HazelIntegrationStatus extends Schema.Class<HazelIntegrationStatus>("HazelIntegrationStatus")({
	connected: Schema.Boolean,
	externalUserId: Schema.NullOr(Schema.String),
	externalUserEmail: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(Schema.String),
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
	returnTo: Schema.optional(Schema.String),
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

export class GithubIntegrationStatus extends Schema.Class<GithubIntegrationStatus>("GithubIntegrationStatus")({
	connected: Schema.Boolean,
	externalUserId: Schema.NullOr(Schema.String),
	externalUserLogin: Schema.NullOr(Schema.String),
	connectedByUserId: Schema.NullOr(Schema.String),
	scope: Schema.NullOr(Schema.String),
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

export class GithubDisconnectResponse extends Schema.Class<GithubDisconnectResponse>(
	"GithubDisconnectResponse",
)({
	disconnected: Schema.Boolean,
}) {}

export class GithubRepoSummary extends Schema.Class<GithubRepoSummary>("GithubRepoSummary")({
	owner: Schema.String,
	name: Schema.String,
	fullName: Schema.String,
	private: Schema.Boolean,
}) {}

export class GithubReposListResponse extends Schema.Class<GithubReposListResponse>("GithubReposListResponse")({
	repos: Schema.Array(GithubRepoSummary),
}) {}

export class ServiceRepoMapping extends Schema.Class<ServiceRepoMapping>("ServiceRepoMapping")({
	serviceName: Schema.String,
	repoOwner: Schema.String,
	repoName: Schema.String,
}) {}

export class ServiceRepoMappingsResponse extends Schema.Class<ServiceRepoMappingsResponse>(
	"ServiceRepoMappingsResponse",
)({
	mappings: Schema.Array(ServiceRepoMapping),
}) {}

export class SetServiceRepoRequest extends Schema.Class<SetServiceRepoRequest>("SetServiceRepoRequest")({
	serviceName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
	repoOwner: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
	repoName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
}) {}

export class DeleteServiceRepoResponse extends Schema.Class<DeleteServiceRepoResponse>(
	"DeleteServiceRepoResponse",
)({
	deleted: Schema.Boolean,
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
				organizationId: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
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
		HttpApiEndpoint.get("githubRepos", "/github/repos", {
			success: GithubReposListResponse,
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
		HttpApiEndpoint.get("githubServiceRepos", "/github/service-repos", {
			success: ServiceRepoMappingsResponse,
			error: IntegrationsPersistenceError,
		}),
	)
	.add(
		HttpApiEndpoint.put("githubSetServiceRepo", "/github/service-repos", {
			payload: SetServiceRepoRequest,
			success: ServiceRepoMapping,
			error: [
				IntegrationsForbiddenError,
				IntegrationsValidationError,
				IntegrationsPersistenceError,
			],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDeleteServiceRepo", "/github/service-repos/:serviceName", {
			params: {
				serviceName: Schema.String.pipe(Schema.check(Schema.isMinLength(1), Schema.isTrimmed())),
			},
			success: DeleteServiceRepoResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.add(
		HttpApiEndpoint.delete("githubDisconnect", "/github", {
			success: GithubDisconnectResponse,
			error: [IntegrationsForbiddenError, IntegrationsPersistenceError],
		}),
	)
	.prefix("/api/integrations")
	.middleware(Authorization) {}
