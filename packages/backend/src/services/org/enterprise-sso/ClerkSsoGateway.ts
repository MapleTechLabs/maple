import * as Clerk from "@distilled.cloud/clerk"
import { type ClerkApi, type ClerkApiServices, clerkModeApi } from "@maple/auth"
import type { OrgId, SsoProvider, UserId } from "@maple/domain/http"
import {
	Array as Arr,
	Context,
	Effect,
	Layer,
	Number as Num,
	Option,
	Order,
	Predicate,
	Redacted,
	String as Str,
} from "effect"
import { Env } from "@maple/backend/platform/Env"
import { ClerkRequestError } from "@maple/auth"

// Every Clerk call the SSO settings make, as `@distilled.cloud/clerk` operations.

export interface ClerkSsoConnection {
	readonly id: string
	readonly name: string
	readonly provider: string
	readonly domains: ReadonlyArray<string>
	readonly organizationId: string | null
	readonly active: boolean
	readonly createdAt: number
	readonly saml: {
		readonly acsUrl: string | null
		readonly spEntityId: string | null
		readonly spMetadataUrl: string | null
		readonly idpMetadataUrl: string | null
		readonly idpSsoUrl: string | null
		readonly idpEntityId: string | null
		readonly certificateExpiresAt: number | null
	} | null
	readonly oidc: {
		readonly discoveryUrl: string | null
		readonly clientId: string | null
		/** What the admin registers in the IdP as the allowed redirect (Clerk's `oauth_callback`). */
		readonly redirectUri: string | null
	} | null
}

export interface ClerkSsoConnectionInput {
	readonly name: string
	readonly domains: ReadonlyArray<string>
	readonly saml?: {
		readonly metadataUrl?: string
		readonly ssoUrl?: string
		readonly entityId?: string
		readonly certificate?: string
	}
	readonly oidc?: {
		readonly discoveryUrl: string
		readonly clientId: string
		readonly clientSecret?: string
	}
}

export interface ClerkSsoDirectory {
	readonly id: string
	readonly endpoint_url: string
	readonly enabled: boolean
	readonly paused: boolean
	readonly group_role_mapping_enabled: boolean
	readonly created_at: number
	readonly api_key?: string | null
}

const byPrecedence = Order.mapInput(Num.Order, (m: { readonly precedence: number }) => m.precedence)

const CONNECTION_PAGE_SIZE = 100
/** 100 pages of 100 connections; past that the scan refuses rather than guess. */
const MAX_CONNECTION_PAGES = 100
const DOMAIN_PAGE_SIZE = 100
const MAX_ORG_DOMAINS = 1_000

interface ConnectionPage<C> {
	readonly data: ReadonlyArray<C>
	readonly totalCount: number
}

/**
 * Folds every enterprise connection Clerk reports. Fails closed: a scan that cannot reach
 * `totalCount` is an error, never a partial answer.
 */
const scanConnections = <C, S>(
	fetchPage: (offset: number) => Effect.Effect<ConnectionPage<C>, ClerkRequestError>,
	initial: S,
	fold: (state: S, page: ReadonlyArray<C>) => S,
	maxPages: number,
): Effect.Effect<S, ClerkRequestError> => {
	// The offset advances by what Clerk returned, never by the limit: a page may come back short.
	const step = (page: number, offset: number, state: S): Effect.Effect<S, ClerkRequestError> =>
		fetchPage(offset).pipe(
			Effect.flatMap((result) => {
				const next = fold(state, result.data)
				const read = offset + result.data.length
				if (read >= result.totalCount) return Effect.succeed(next)
				// An empty page short of the total, or the page budget spent: the scan is incomplete.
				if (result.data.length === 0 || page + 1 >= maxPages) {
					return Effect.fail(
						new ClerkRequestError({
							message: `Could not read all ${result.totalCount} enterprise connections`,
							status: null,
							cause: null,
						}),
					)
				}
				return step(page + 1, read, next)
			}),
		)
	return step(0, 0, initial)
}

/**
 * Which of `domains` a connection other than `connectionId` serves, reading every page Clerk
 * reports. A miss would let a bypass change reach another org, so an incomplete scan fails.
 */
export const scanClaimedDomains = (
	fetchPage: (
		offset: number,
	) => Effect.Effect<
		ConnectionPage<{ readonly id: string; readonly domains: ReadonlyArray<string> }>,
		ClerkRequestError
	>,
	connectionId: string,
	domains: ReadonlyArray<string>,
	maxPages: number = MAX_CONNECTION_PAGES,
): Effect.Effect<ReadonlyArray<string>, ClerkRequestError> =>
	scanConnections(
		fetchPage,
		new Set<string>(),
		(claimed, page) => {
			const next = new Set(claimed)
			Arr.forEach(page, (conn) => {
				if (conn.id !== connectionId) Arr.forEach(conn.domains, (d) => next.add(Str.toLowerCase(d)))
			})
			return next
		},
		maxPages,
	).pipe(Effect.map((claimed) => Arr.filter(domains, (d) => claimed.has(d))))

/**
 * Clerk keeps connection names unique across the whole instance, but its 422 does not say which
 * field clashed: true when a connection other than `connectionId` already holds `name`.
 */
export const isNameHeldElsewhere = (
	fetchPage: (
		offset: number,
	) => Effect.Effect<ConnectionPage<{ readonly id: string; readonly name: string }>, ClerkRequestError>,
	connectionId: string | null,
	name: string,
	maxPages: number = MAX_CONNECTION_PAGES,
): Effect.Effect<boolean, ClerkRequestError> => {
	const wanted = Str.toLowerCase(name)
	return scanConnections(
		fetchPage,
		false,
		(held, page) =>
			held ||
			Arr.some(page, (conn) => conn.id !== connectionId && Str.toLowerCase(conn.name) === wanted),
		maxPages,
	)
}

export interface ClerkSsoRoleMapping {
	readonly groupId: string
	readonly groupName: string | null
	readonly roleKey: string
}

export interface ClerkSsoBypassUser {
	readonly userId: string
	readonly identifier: string | null
}

export interface ClerkSsoGatewayApi {
	/** False outside Clerk mode (self-hosted): there is no IdP integration to configure. */
	readonly available: boolean
	readonly listRoles: Effect.Effect<ReadonlyArray<{ id: string; key: string }>, ClerkRequestError>
	/** Creates the organization domain, or finds it when the org already has it, and returns its id. */
	readonly ensureOrgDomain: (orgId: OrgId, domain: string) => Effect.Effect<string, ClerkRequestError>
	/** Marks DNS ownership proven; Maple checked the TXT record itself. */
	readonly verifyOrgDomainOwnership: (
		orgId: OrgId,
		domainId: string,
	) => Effect.Effect<void, ClerkRequestError>
	readonly deleteOrgDomain: (orgId: OrgId, domainId: string) => Effect.Effect<void, ClerkRequestError>
	readonly getConnection: (id: string) => Effect.Effect<ClerkSsoConnection, ClerkRequestError>
	readonly createConnection: (
		orgId: OrgId,
		provider: SsoProvider,
		input: ClerkSsoConnectionInput,
	) => Effect.Effect<ClerkSsoConnection, ClerkRequestError>
	readonly updateConnection: (
		id: string,
		input: Partial<ClerkSsoConnectionInput> & { readonly active?: boolean },
	) => Effect.Effect<ClerkSsoConnection, ClerkRequestError>
	readonly deleteConnection: (id: string) => Effect.Effect<void, ClerkRequestError>
	readonly createDirectory: (
		connectionId: string,
		provider: "okta" | "entra" | "custom",
	) => Effect.Effect<ClerkSsoDirectory, ClerkRequestError>
	readonly getDirectory: (id: string) => Effect.Effect<ClerkSsoDirectory, ClerkRequestError>
	readonly updateDirectory: (
		id: string,
		patch: { readonly paused?: boolean; readonly group_role_mapping_enabled?: boolean },
	) => Effect.Effect<ClerkSsoDirectory, ClerkRequestError>
	readonly rotateDirectoryKey: (id: string) => Effect.Effect<ClerkSsoDirectory, ClerkRequestError>
	readonly deleteDirectory: (id: string) => Effect.Effect<void, ClerkRequestError>
	/** Which of `domains` another enterprise connection in the instance serves. */
	readonly domainsClaimedElsewhere: (
		connectionId: string,
		domains: ReadonlyArray<string>,
	) => Effect.Effect<ReadonlyArray<string>, ClerkRequestError>
	/** True when Clerk holds the user deprovisioned, or no longer has the user at all. */
	readonly isDeprovisioned: (userId: UserId) => Effect.Effect<boolean, ClerkRequestError>
	readonly isMember: (orgId: OrgId, userId: UserId) => Effect.Effect<boolean, ClerkRequestError>
	/** The domains of the user's verified email addresses, lower-cased. */
	readonly verifiedEmailDomains: (userId: UserId) => Effect.Effect<ReadonlyArray<string>, ClerkRequestError>
	readonly listRoleMappings: (
		directoryId: string,
	) => Effect.Effect<ReadonlyArray<ClerkSsoRoleMapping>, ClerkRequestError>
	readonly replaceRoleMappings: (
		directoryId: string,
		mappings: ReadonlyArray<{ readonly groupId: string; readonly roleId: string }>,
	) => Effect.Effect<void, ClerkRequestError>
	readonly listBypassUsers: (
		connectionId: string,
	) => Effect.Effect<ReadonlyArray<ClerkSsoBypassUser>, ClerkRequestError>
	readonly addBypassUser: (userId: UserId) => Effect.Effect<void, ClerkRequestError>
	readonly removeBypassUser: (userId: UserId) => Effect.Effect<void, ClerkRequestError>
}

const orNull = (value: string | null | undefined): string | null =>
	value === undefined || value === null || value === "" ? null : value

/** `oauth_config.redirect_uri` is outside Clerk's spec; the lenient decode keeps it on the wire object. */
const redirectUri = (config: Clerk.EnterpriseConnectionOauthConfig): string | null =>
	Predicate.hasProperty(config, "redirect_uri") && Predicate.isString(config.redirect_uri)
		? orNull(config.redirect_uri)
		: null

const toConnection = (c: Clerk.EnterpriseConnection): ClerkSsoConnection => ({
	id: c.id,
	name: c.name,
	provider: c.provider,
	domains: c.domains,
	organizationId: c.organization_id ?? null,
	active: c.active,
	createdAt: c.created_at,
	saml:
		c.saml_connection === undefined || c.saml_connection === null
			? null
			: {
					acsUrl: orNull(c.saml_connection.acs_url),
					spEntityId: orNull(c.saml_connection.sp_entity_id),
					spMetadataUrl: orNull(c.saml_connection.sp_metadata_url),
					idpMetadataUrl: orNull(c.saml_connection.idp_metadata_url),
					idpSsoUrl: orNull(c.saml_connection.idp_sso_url),
					idpEntityId: orNull(c.saml_connection.idp_entity_id),
					certificateExpiresAt: c.saml_connection.idp_certificate_expires_at ?? null,
				},
	oidc:
		c.oauth_config === undefined || c.oauth_config === null
			? null
			: {
					discoveryUrl: orNull(c.oauth_config.discovery_url),
					clientId: orNull(c.oauth_config.client_id),
					redirectUri: redirectUri(c.oauth_config),
				},
})

/** The SCIM key arrives as `Redacted` (a sensitive member); callers hand it to the admin once. */
const toDirectory = (d: Clerk.Directory): ClerkSsoDirectory => ({
	id: d.id,
	endpoint_url: d.endpoint_url,
	enabled: d.enabled,
	paused: d.paused,
	group_role_mapping_enabled: d.group_role_mapping_enabled,
	created_at: d.created_at,
	api_key:
		d.api_key === undefined || d.api_key === null
			? null
			: Redacted.isRedacted(d.api_key)
				? Redacted.value(d.api_key)
				: d.api_key,
})

/** A taken name made unique by the org's own domain, which no other org can hold. */
export const disambiguatedName = (name: string, domains: ReadonlyArray<string>): string =>
	Option.match(Arr.head(domains), { onNone: () => name, onSome: (domain) => `${name} (${domain})` })

const samlParams = (
	saml: NonNullable<ClerkSsoConnectionInput["saml"]>,
): Clerk.CreateEnterpriseConnectionRequestSaml => {
	if (saml.metadataUrl !== undefined) return { idp_metadata_url: saml.metadataUrl }
	const params: Clerk.CreateEnterpriseConnectionRequestSaml = {
		idp_sso_url: saml.ssoUrl,
		idp_entity_id: saml.entityId,
	}
	if (saml.certificate !== undefined) params.idp_certificates = [saml.certificate]
	return params
}

const oidcParams = (
	oidc: NonNullable<ClerkSsoConnectionInput["oidc"]>,
): Clerk.CreateEnterpriseConnectionRequestOidc => {
	const params: Clerk.CreateEnterpriseConnectionRequestOidc = {
		discovery_url: oidc.discoveryUrl,
		client_id: oidc.clientId,
	}
	if (oidc.clientSecret !== undefined) params.client_secret = oidc.clientSecret
	return params
}

const createParams = (
	orgId: OrgId,
	provider: SsoProvider,
	input: ClerkSsoConnectionInput,
): Clerk.CreateEnterpriseConnectionRequest => {
	const params: Clerk.CreateEnterpriseConnectionRequest = {
		name: input.name,
		domains: [...input.domains],
		organization_id: orgId,
		provider,
		// Never live on create: the admin enforces it once a sign-in works.
		active: false,
		allow_organization_account_linking: true,
	}
	if (input.saml !== undefined) params.saml = samlParams(input.saml)
	if (input.oidc !== undefined) params.oidc = oidcParams(input.oidc)
	return params
}

/** Clerk's update body: only what the caller set, so an omitted secret keeps the stored one. */
export const updateParams = (
	input: Partial<ClerkSsoConnectionInput> & { readonly active?: boolean },
): Omit<Clerk.UpdateEnterpriseConnectionRequest, "enterprise_connection_id"> => {
	const params: Omit<Clerk.UpdateEnterpriseConnectionRequest, "enterprise_connection_id"> = {}
	if (input.name !== undefined) params.name = input.name
	if (input.domains !== undefined) params.domains = [...input.domains]
	if (input.active !== undefined) params.active = input.active
	// Requiring SSO restates Clerk's default: members of the domains cannot add another email,
	// password, passkey or social account. It is never loosened from here.
	if (input.active === true) params.disable_additional_identifications = true
	if (input.saml !== undefined) params.saml = samlParams(input.saml)
	if (input.oidc !== undefined) params.oidc = oidcParams(input.oidc)
	return params
}

/** The gateway over one Clerk Backend API; `undefined` outside Clerk mode. */
export const makeClerkSsoGateway = (api: ClerkApi | undefined): ClerkSsoGatewayApi => {
	const call = <A, E>(
		request: Effect.Effect<A, E, ClerkApiServices>,
	): Effect.Effect<A, ClerkRequestError> =>
		api === undefined
			? Effect.fail(
					new ClerkRequestError({
						message: "Clerk is not configured",
						status: null,
						cause: null,
					}),
				)
			: api.run(request)

	const listConnectionsPage = (offset: number) =>
		call(Clerk.listEnterpriseConnections({ limit: CONNECTION_PAGE_SIZE, offset })).pipe(
			Effect.map((page) => ({ data: page.data, totalCount: page.total_count })),
		)

	/** On a 422, retries under the disambiguated name only when another connection holds `name`. */
	const retryIfNameTaken =
		<A>(connectionId: string | null, name: string, retry: Effect.Effect<A, ClerkRequestError>) =>
		(error: ClerkRequestError): Effect.Effect<A, ClerkRequestError> =>
			error.status !== 422
				? Effect.fail(error)
				: isNameHeldElsewhere(listConnectionsPage, connectionId, name).pipe(
						Effect.mapError(() => error),
						Effect.flatMap((held) => (held ? retry : Effect.fail(error))),
					)

	/** The org's domains, a page at a time, up to {@link MAX_ORG_DOMAINS}. */
	const listOrgDomains = (orgId: OrgId) => {
		const page = (
			offset: number,
			acc: ReadonlyArray<Clerk.OrganizationDomain>,
		): Effect.Effect<ReadonlyArray<Clerk.OrganizationDomain>, ClerkRequestError> =>
			call(
				Clerk.listOrganizationDomains({ organization_id: orgId, limit: DOMAIN_PAGE_SIZE, offset }),
			).pipe(
				Effect.flatMap((result) => {
					const all = Arr.appendAll(acc, result.data)
					const next = offset + DOMAIN_PAGE_SIZE
					return result.data.length < DOMAIN_PAGE_SIZE || next >= MAX_ORG_DOMAINS
						? Effect.succeed(all)
						: page(next, all)
				}),
			)
		return page(0, [])
	}

	const gateway: ClerkSsoGatewayApi = {
		available: api !== undefined,
		listRoles: call(Clerk.listOrganizationRoles({ limit: 100 })).pipe(
			Effect.map((page) => Arr.map(page.data, (role) => ({ id: role.id, key: role.key }))),
		),
		ensureOrgDomain: (orgId, domain) =>
			call(
				Clerk.createOrganizationDomain({
					organization_id: orgId,
					name: domain,
					enrollment_mode: "manual_invitation",
					verified: true,
				}),
			).pipe(
				Effect.map((d) => d.id),
				// Already on the org (the Domains tab added it): reuse that one.
				Effect.catchIf(
					(error) => error.status === 422 || error.status === 409 || error.status === 400,
					(error) =>
						listOrgDomains(orgId).pipe(
							Effect.flatMap((domains) =>
								Option.match(
									Arr.findFirst(domains, (d) => d.name === domain),
									{ onNone: () => Effect.fail(error), onSome: (d) => Effect.succeed(d.id) },
								),
							),
						),
				),
			),
		verifyOrgDomainOwnership: (orgId, domainId) =>
			call(
				Clerk.verifyOrganizationDomainOwnership({ organization_id: orgId, domain_id: domainId }),
			).pipe(Effect.asVoid),
		deleteOrgDomain: (orgId, domainId) =>
			call(Clerk.deleteOrganizationDomain({ organization_id: orgId, domain_id: domainId })).pipe(
				Effect.asVoid,
			),
		getConnection: (id) =>
			call(Clerk.getEnterpriseConnection({ enterprise_connection_id: id })).pipe(
				Effect.map(toConnection),
			),
		createConnection: (orgId, provider, input) => {
			const create = (name: string) =>
				call(Clerk.createEnterpriseConnection(createParams(orgId, provider, { ...input, name })))
			return create(input.name).pipe(
				Effect.catch(
					retryIfNameTaken(null, input.name, create(disambiguatedName(input.name, input.domains))),
				),
				Effect.map(toConnection),
			)
		},
		updateConnection: (id, input) => {
			const update = (patch: typeof input) =>
				call(
					Clerk.updateEnterpriseConnection({
						enterprise_connection_id: id,
						...updateParams(patch),
					}),
				)
			const name = input.name
			return update(input).pipe(
				Effect.catch((error) =>
					name === undefined
						? Effect.fail(error)
						: retryIfNameTaken(
								id,
								name,
								update({ ...input, name: disambiguatedName(name, input.domains ?? []) }),
							)(error),
				),
				Effect.map(toConnection),
			)
		},
		deleteConnection: (id) =>
			call(Clerk.deleteEnterpriseConnection({ enterprise_connection_id: id })).pipe(Effect.asVoid),
		createDirectory: (connectionId, provider) =>
			call(
				Clerk.createDirectory({
					enterprise_connection_id: connectionId,
					provider,
					name: "Maple SCIM",
				}),
			).pipe(Effect.map(toDirectory)),
		getDirectory: (id) => call(Clerk.getDirectory({ directory_id: id })).pipe(Effect.map(toDirectory)),
		updateDirectory: (id, patch) =>
			call(Clerk.updateDirectory({ directory_id: id, ...patch })).pipe(Effect.map(toDirectory)),
		rotateDirectoryKey: (id) =>
			call(Clerk.rotateDirectoryAPIKey({ directory_id: id })).pipe(Effect.map(toDirectory)),
		deleteDirectory: (id) => call(Clerk.deleteDirectory({ directory_id: id })).pipe(Effect.asVoid),
		domainsClaimedElsewhere: (connectionId, domains) =>
			domains.length === 0
				? Effect.succeed([])
				: scanClaimedDomains(listConnectionsPage, connectionId, domains),
		isDeprovisioned: (userId) =>
			call(Clerk.getUser({ user_id: userId })).pipe(
				Effect.map((user) => user.deprovisioned === true),
				Effect.catchIf(
					(e) => e.status === 404,
					() => Effect.succeed(true),
				),
			),
		isMember: (orgId, userId) =>
			call(
				Clerk.listOrganizationMemberships({ organization_id: orgId, user_id: [userId], limit: 1 }),
			).pipe(Effect.map((page) => page.data.length > 0)),
		verifiedEmailDomains: (userId) =>
			call(Clerk.getUser({ user_id: userId })).pipe(
				Effect.map((user) =>
					Arr.flatMap(user.email_addresses, (e) =>
						e.verification?.status === "verified"
							? Option.toArray(
									Option.map(Arr.last(Str.split(e.email_address, "@")), Str.toLowerCase),
								)
							: [],
					),
				),
			),
		listRoleMappings: (directoryId) =>
			call(Clerk.listDirectoryGroupRoleMappings({ directory_id: directoryId })).pipe(
				Effect.map((list) =>
					Arr.flatMap(Arr.sort(list.data, byPrecedence), (m: Clerk.DirectoryGroupRoleMapping) =>
						m.role === undefined
							? []
							: [
									{
										groupId: m.directory_group_id || m.scim_group_id,
										groupName: orNull(m.directory_group_display_name),
										roleKey: m.role.key,
									},
								],
					),
				),
			),
		replaceRoleMappings: (directoryId, mappings) =>
			call(
				Clerk.replaceDirectoryGroupRoleMappings({
					directory_id: directoryId,
					mappings: Arr.map(mappings, (m) => ({
						directory_group_id: m.groupId,
						role_id: m.roleId,
					})),
				}),
			).pipe(Effect.asVoid),
		listBypassUsers: (connectionId) =>
			call(Clerk.listSSOBypassAllowlistUsers({ enterprise_connection_id: connectionId })).pipe(
				Effect.map((list) =>
					Arr.map(list, (u) => ({
						userId: u.user_id,
						identifier: orNull(u.public_user_data.identifier),
					})),
				),
			),
		addBypassUser: (userId) =>
			call(Clerk.createSSOBypassAllowlistUser({ user_id: userId })).pipe(Effect.asVoid),
		removeBypassUser: (userId) =>
			call(Clerk.deleteSSOBypassAllowlistUser({ userID: userId })).pipe(Effect.asVoid),
	}
	return gateway
}

const make = Effect.gen(function* () {
	const env = yield* Env
	return makeClerkSsoGateway(clerkModeApi(env))
})

export class ClerkSsoGateway extends Context.Service<ClerkSsoGateway, ClerkSsoGatewayApi>()(
	"@maple/backend/services/org/enterprise-sso/ClerkSsoGateway",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make)
}
