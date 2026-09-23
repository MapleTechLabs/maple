import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { OrgId } from "../primitives"
import { MapleRegion } from "../organization-regions"
import { Authorization, UserSessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"

export class DeleteOrganizationResponse extends Schema.Class<DeleteOrganizationResponse>(
	"DeleteOrganizationResponse",
)({
	deleted: Schema.Literal(true),
}) {}

export class OrganizationForbiddenError extends HttpTaggedError<OrganizationForbiddenError>()(
	"@maple/http/errors/OrganizationForbiddenError",
	{
		message: Schema.String,
	},
	{
		status: 403,
		code: "organization_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

export class OrganizationPersistenceError extends HttpTaggedError<OrganizationPersistenceError>()(
	"@maple/http/errors/OrganizationPersistenceError",
	{
		message: Schema.String,
	},
	{
		status: 503,
		code: "organization_persistence_unavailable",
		title: "Organization storage is temporarily unavailable",
		message: "Organization storage is temporarily unavailable. Retry in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class OrganizationProviderError extends HttpTaggedError<OrganizationProviderError>()(
	"@maple/http/errors/OrganizationProviderError",
	{
		message: Schema.String,
	},
	{
		status: 502,
		code: "organization_provider_unavailable",
		title: "Organization provider unavailable",
		message: "The organization provider is temporarily unavailable.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class OrganizationsApiGroup extends HttpApiGroup.make("organizations")
	.add(
		HttpApiEndpoint.delete("delete", "/", {
			success: DeleteOrganizationResponse,
			error: [OrganizationForbiddenError, OrganizationPersistenceError, OrganizationProviderError],
		}),
	)
	.prefix("/api/organizations")
	.middleware(Authorization) {}

export class CreateOrganizationRequest extends Schema.Class<CreateOrganizationRequest>(
	"CreateOrganizationRequest",
)({
	name: Schema.Trim.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
	/** Where the organization's data will live. Fixed for the organization's lifetime. */
	region: MapleRegion,
}) {}

export class CreateOrganizationResponse extends Schema.Class<CreateOrganizationResponse>(
	"CreateOrganizationResponse",
)({
	orgId: OrgId,
	region: MapleRegion,
}) {}

/**
 * Creating an organization, which happens before the caller has one, so it authenticates the
 * user alone. The organization is created with its region already set: the browser SDK cannot
 * write the metadata that decides which instance serves it.
 */
export class OrganizationCreationApiGroup extends HttpApiGroup.make("organizationCreation")
	.add(
		HttpApiEndpoint.post("create", "/", {
			payload: CreateOrganizationRequest,
			success: CreateOrganizationResponse,
			error: [OrganizationProviderError],
		}),
	)
	.prefix("/api/organizations")
	.middleware(UserSessionAuthorization) {}
