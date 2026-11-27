import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema, String as Str } from "effect"
import { IsoDateTimeString, UserId } from "@maple/primitives"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { EndpointAccess, handler } from "./endpoint-access"

/**
 * Lower-cased hostname with at least one dot, no wildcard and no trailing dot. Capped at 236 so
 * `_maple-challenge.<domain>` stays within DNS's 253-character name limit.
 */
export const SsoDomainName = Schema.String.check(
	Schema.isMaxLength(236),
	Schema.isPattern(/^(?=.{1,236}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/),
)

/** Where the TXT challenge is published: `_maple-challenge.<domain>`. */
export const SSO_CHALLENGE_RECORD_PREFIX = "_maple-challenge"

export const SsoProtocol = Schema.Literals(["saml", "oidc"])
export type SsoProtocol = typeof SsoProtocol.Type

/** Clerk's organization enterprise connection providers. */
export const SsoProvider = Schema.Literals([
	"saml_custom",
	"saml_okta",
	"saml_microsoft",
	"saml_google",
	"oidc_custom",
	"oidc_github_enterprise",
	"oidc_gitlab",
])
export type SsoProvider = typeof SsoProvider.Type

export const ssoProtocolOf = (provider: SsoProvider): SsoProtocol =>
	Str.startsWith("saml_")(provider) ? "saml" : "oidc"

/** The Clerk role keys a SCIM group can grant. Engineer is included: it is a Maple role in Clerk too. */
export const SsoMappedRole = Schema.Literals(["org:admin", "org:engineer", "org:member", "org:analyst"])
export type SsoMappedRole = typeof SsoMappedRole.Type

export class SsoDomainDocument extends Schema.Class<SsoDomainDocument>("SsoDomainDocument")({
	domain: Schema.String,
	status: Schema.Literals(["pending", "verified"]),
	/** The TXT record to publish, e.g. `_maple-challenge.acme.com`. */
	recordName: Schema.String,
	recordValue: Schema.String,
	verifiedAt: Schema.NullOr(IsoDateTimeString),
}) {}

export class SsoConnectionDocument extends Schema.Class<SsoConnectionDocument>("SsoConnectionDocument")({
	name: Schema.String,
	provider: SsoProvider,
	protocol: SsoProtocol,
	domains: Schema.Array(Schema.String),
	/** Clerk's `active`: everyone signing in with an email on these domains must use the IdP. */
	enforced: Schema.Boolean,
	/** What the customer pastes into their IdP (SAML service provider values). */
	acsUrl: Schema.NullOr(Schema.String),
	spEntityId: Schema.NullOr(Schema.String),
	spMetadataUrl: Schema.NullOr(Schema.String),
	/** The IdP side as configured; the certificate and the OIDC client secret never come back. */
	idpMetadataUrl: Schema.NullOr(Schema.String),
	idpSsoUrl: Schema.NullOr(Schema.String),
	idpEntityId: Schema.NullOr(Schema.String),
	idpCertificateExpiresAt: Schema.NullOr(IsoDateTimeString),
	oidcDiscoveryUrl: Schema.NullOr(Schema.String),
	oidcClientId: Schema.NullOr(Schema.String),
	/** OIDC only: the redirect URI the admin allows in the IdP application. */
	oidcRedirectUri: Schema.NullOr(Schema.String),
	createdAt: IsoDateTimeString,
}) {}

export class ScimDirectoryDocument extends Schema.Class<ScimDirectoryDocument>("ScimDirectoryDocument")({
	/** The SCIM 2.0 base URL the IdP pushes to. Absent for a reader without `sso:manage`. */
	endpointUrl: Schema.optionalKey(Schema.String),
	enabled: Schema.Boolean,
	paused: Schema.Boolean,
	createdAt: IsoDateTimeString,
}) {}

export class ScimRoleMappingDocument extends Schema.Class<ScimRoleMappingDocument>("ScimRoleMappingDocument")(
	{
		groupId: Schema.String,
		groupName: Schema.NullOr(Schema.String),
		role: SsoMappedRole,
	},
) {}

export class ScimGroupDocument extends Schema.Class<ScimGroupDocument>("ScimGroupDocument")({
	groupId: Schema.String,
	displayName: Schema.String,
}) {}

export class SsoBypassUserDocument extends Schema.Class<SsoBypassUserDocument>("SsoBypassUserDocument")({
	userId: UserId,
	identifier: Schema.NullOr(Schema.String),
}) {}

/**
 * The whole Security tab in one read. A reader without `sso:manage` gets the state only: the
 * domains, the connection without its IdP and service provider values, the directory without its
 * endpoint, and no role mappings, groups or bypass users.
 */
export class EnterpriseSsoDocument extends Schema.Class<EnterpriseSsoDocument>("EnterpriseSsoDocument")({
	/** The org holds the single sign-on add-on (`enterprise_sso`). Reads answer either way. */
	ssoEntitled: Schema.Boolean,
	/** The org holds the SCIM provisioning add-on (`enterprise_scim`). */
	scimEntitled: Schema.Boolean,
	domains: Schema.Array(SsoDomainDocument),
	connection: Schema.NullOr(SsoConnectionDocument),
	directory: Schema.NullOr(ScimDirectoryDocument),
	/** Highest precedence first. */
	roleMappings: Schema.Array(ScimRoleMappingDocument),
	groups: Schema.Array(ScimGroupDocument),
	bypassUsers: Schema.Array(SsoBypassUserDocument),
}) {}

/** A directory write that minted a SCIM token: the only response that ever carries it. */
export class ScimTokenIssued extends Schema.Class<ScimTokenIssued>("ScimTokenIssued")({
	document: EnterpriseSsoDocument,
	token: Schema.String,
}) {}

export class SsoAddDomainRequest extends Schema.Class<SsoAddDomainRequest>("SsoAddDomainRequest")({
	domain: Schema.String.check(Schema.isMaxLength(253)),
}) {}

const Url = Schema.String.check(Schema.isMaxLength(2048), Schema.isPattern(/^https:\/\//))

export class SsoSamlSettings extends Schema.Class<SsoSamlSettings>("SsoSamlSettings")({
	/** Either a metadata URL, or the three manual fields. */
	metadataUrl: Schema.optionalKey(Url),
	ssoUrl: Schema.optionalKey(Url),
	entityId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
	certificate: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16_384))),
}) {}

export class SsoOidcSettings extends Schema.Class<SsoOidcSettings>("SsoOidcSettings")({
	discoveryUrl: Url,
	clientId: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
	/** Required on create; omitted on update keeps the stored one. */
	clientSecret: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(2048))),
}) {}

export class SsoConnectionRequest extends Schema.Class<SsoConnectionRequest>("SsoConnectionRequest")({
	name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(120)),
	/** Ignored on update: Clerk cannot change a connection's provider. */
	provider: SsoProvider,
	/** Verified domains only. */
	domains: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
	saml: Schema.optionalKey(SsoSamlSettings),
	oidc: Schema.optionalKey(SsoOidcSettings),
}) {}

export class SsoEnforcementRequest extends Schema.Class<SsoEnforcementRequest>("SsoEnforcementRequest")({
	enforced: Schema.Boolean,
}) {}

export class ScimDirectoryStateRequest extends Schema.Class<ScimDirectoryStateRequest>(
	"ScimDirectoryStateRequest",
)({
	paused: Schema.Boolean,
}) {}

export class ScimRoleMappingsRequest extends Schema.Class<ScimRoleMappingsRequest>("ScimRoleMappingsRequest")(
	{
		/** Precedence is array order: the first mapping wins for a user in several groups. */
		mappings: Schema.Array(
			Schema.Struct({ groupId: Schema.String.check(Schema.isMinLength(1)), role: SsoMappedRole }),
		).check(Schema.isMaxLength(100)),
	},
) {}

export class SsoBypassRequest extends Schema.Class<SsoBypassRequest>("SsoBypassRequest")({
	userId: UserId,
}) {}

/** Clerk or the database could not be reached; its own text can carry internals. */
export class EnterpriseSsoUnavailableError extends HttpTaggedError<EnterpriseSsoUnavailableError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoUnavailableError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.String) },
	{
		status: 503,
		code: "enterprise_sso_unavailable",
		title: "SSO settings are temporarily unavailable",
		message: "SSO settings could not be read or saved right now. Try again in a few seconds.",
		retry: "backoff",
		recovery: "retry",
		exposure: "redacted",
	},
) {}

export class EnterpriseSsoForbiddenError extends HttpTaggedError<EnterpriseSsoForbiddenError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoForbiddenError",
	{ message: Schema.String },
	{
		status: 403,
		code: "enterprise_sso_forbidden",
		title: "Permission required",
		retry: "never",
		recovery: "request_access",
		exposure: "public_message",
	},
) {}

/** The org does not hold the add-on the write needs (single sign-on or SCIM provisioning). */
export class EnterpriseSsoNotEntitledError extends HttpTaggedError<EnterpriseSsoNotEntitledError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoNotEntitledError",
	{ message: Schema.String },
	{
		status: 402,
		code: "enterprise_sso_not_entitled",
		title: "Add-on required",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** A malformed value, an unverified domain, or settings the IdP or Clerk rejected. */
export class EnterpriseSsoInvalidError extends HttpTaggedError<EnterpriseSsoInvalidError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoInvalidError",
	{ message: Schema.String },
	{
		status: 400,
		code: "enterprise_sso_invalid",
		title: "SSO settings not accepted",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** The thing already exists, or the domain is claimed by another organization. */
export class EnterpriseSsoConflictError extends HttpTaggedError<EnterpriseSsoConflictError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoConflictError",
	{ message: Schema.String },
	{
		status: 409,
		code: "enterprise_sso_conflict",
		title: "Already set up",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

/** A connection domain whose ownership TXT record is no longer published. */
export class EnterpriseSsoDomainProofError extends HttpTaggedError<EnterpriseSsoDomainProofError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoDomainProofError",
	{
		message: Schema.String,
		domain: Schema.String,
		recordName: Schema.String,
		recordValue: Schema.String,
	},
	{
		status: 409,
		code: "enterprise_sso_domain_proof_missing",
		title: "Domain proof missing",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

export class EnterpriseSsoNotFoundError extends HttpTaggedError<EnterpriseSsoNotFoundError>()(
	"@maple/http/enterprise-sso/EnterpriseSsoNotFoundError",
	{ message: Schema.String },
	{
		status: 404,
		code: "enterprise_sso_not_found",
		title: "Not set up",
		retry: "never",
		recovery: "fix_request",
		exposure: "public_message",
	},
) {}

const readErrors = [EnterpriseSsoUnavailableError] as const
const writeErrors = [
	EnterpriseSsoUnavailableError,
	EnterpriseSsoForbiddenError,
	EnterpriseSsoNotEntitledError,
	EnterpriseSsoInvalidError,
	EnterpriseSsoConflictError,
	EnterpriseSsoDomainProofError,
	EnterpriseSsoNotFoundError,
] as const

export class EnterpriseSsoApiGroup extends HttpApiGroup.make("enterpriseSso")
	.add(
		// Without `sso:manage` the read answers with the summary, not the settings.
		HttpApiEndpoint.get("get", "/", {
			success: EnterpriseSsoDocument,
			error: readErrors,
		}).annotate(EndpointAccess, handler("sso:manage")),
	)
	.add(
		HttpApiEndpoint.post("addDomain", "/domains", {
			payload: SsoAddDomainRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("verifyDomain", "/domains/:domain/verify", {
			params: { domain: Schema.String },
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeDomain", "/domains/:domain", {
			params: { domain: Schema.String },
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("createConnection", "/connection", {
			payload: SsoConnectionRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.patch("updateConnection", "/connection", {
			payload: SsoConnectionRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.put("setEnforcement", "/connection/enforcement", {
			payload: SsoEnforcementRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteConnection", "/connection", {
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("createDirectory", "/directory", {
			success: ScimTokenIssued,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("rotateDirectoryToken", "/directory/token", {
			success: ScimTokenIssued,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.put("setDirectoryState", "/directory/state", {
			payload: ScimDirectoryStateRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("deleteDirectory", "/directory", {
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.put("setRoleMappings", "/directory/role-mappings", {
			payload: ScimRoleMappingsRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.post("addBypassUser", "/bypass", {
			payload: SsoBypassRequest,
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.add(
		HttpApiEndpoint.delete("removeBypassUser", "/bypass/:userId", {
			params: { userId: UserId },
			success: EnterpriseSsoDocument,
			error: writeErrors,
		}),
	)
	.prefix("/internal/enterprise-sso")
	.middleware(SessionAuthorization)
	.annotate(EndpointAccess, handler("sso:manage")) {}
