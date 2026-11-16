import type { ClerkClient, EnterpriseConnection } from "@clerk/backend"
import { clerkModeClient } from "@maple/auth"
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
	Schema,
	String as Str,
} from "effect"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import {
	CLERK_REQUEST_TIMEOUT,
	ClerkRequestError,
	clerkRequest,
} from "@maple/backend/services/auth/clerk-request"

// Every Clerk call the SSO settings make. Directories, role mappings, the bypass allowlist and the
// domain ownership override are newer than @clerk/backend's methods, so those go over HTTP.

type ConnectionApi = ClerkClient["enterpriseConnections"]
// @clerk/backend does not export its param types from the root.
type CreateEnterpriseConnectionParams = Parameters<ConnectionApi["createEnterpriseConnection"]>[0]
type UpdateEnterpriseConnectionParams = Parameters<ConnectionApi["updateEnterpriseConnection"]>[1]
type EnterpriseConnectionSamlParams = NonNullable<CreateEnterpriseConnectionParams["saml"]>

const CLERK_API_URL = "https://api.clerk.com/v1"
/** The version @clerk/backend 3.29 pins; every directory endpoint used here exists in it. */
const CLERK_API_VERSION = "2026-05-12"

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
	readonly oidc: { readonly discoveryUrl: string | null; readonly clientId: string | null } | null
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

const DirectoryJson = Schema.Struct({
	id: Schema.String,
	endpoint_url: Schema.String,
	enabled: Schema.Boolean,
	paused: Schema.Boolean,
	group_role_mapping_enabled: Schema.Boolean,
	created_at: Schema.Number,
	api_key: Schema.optionalKey(Schema.NullOr(Schema.String)),
})
export type ClerkSsoDirectory = typeof DirectoryJson.Type

const RoleMappingJson = Schema.Struct({
	directory_group_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	scim_group_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
	directory_group_display_name: Schema.optionalKey(Schema.NullOr(Schema.String)),
	role: Schema.Struct({ id: Schema.String, key: Schema.String }),
	precedence: Schema.Number,
})
const byPrecedence = Order.mapInput(Num.Order, (m: { readonly precedence: number }) => m.precedence)
const UserFlags = Schema.Struct({ deprovisioned: Schema.optionalKey(Schema.NullOr(Schema.Boolean)) })

const CONNECTION_PAGE_SIZE = 100
/** 100 pages of 100 connections; past that the scan refuses rather than guess. */
const MAX_CONNECTION_PAGES = 100

interface ConnectionPage {
	readonly data: ReadonlyArray<{ readonly id: string; readonly domains: ReadonlyArray<string> }>
	readonly totalCount: number
}

/**
 * Which of `domains` a connection other than `connectionId` serves, reading every page Clerk
 * reports. Fails closed: a scan that cannot reach `totalCount` is an error, never a partial answer,
 * since a miss would let a bypass change reach another org.
 */
export const scanClaimedDomains = (
	fetchPage: (offset: number) => Effect.Effect<ConnectionPage, ClerkRequestError>,
	connectionId: string,
	domains: ReadonlyArray<string>,
	maxPages: number = MAX_CONNECTION_PAGES,
): Effect.Effect<ReadonlyArray<string>, ClerkRequestError> => {
	const step = (
		page: number,
		claimed: ReadonlySet<string>,
	): Effect.Effect<ReadonlySet<string>, ClerkRequestError> =>
		fetchPage(page * CONNECTION_PAGE_SIZE).pipe(
			Effect.flatMap((result) => {
				const next = new Set(claimed)
				Arr.forEach(result.data, (conn) => {
					if (conn.id !== connectionId)
						Arr.forEach(conn.domains, (d) => next.add(Str.toLowerCase(d)))
				})
				const seen = page * CONNECTION_PAGE_SIZE + result.data.length
				if (seen >= result.totalCount || result.data.length === 0) return Effect.succeed(next)
				if (page + 1 >= maxPages) {
					return Effect.fail(
						new ClerkRequestError({
							operation: "Clerk.enterpriseConnections.list",
							message: `Could not read all ${result.totalCount} enterprise connections`,
							status: null,
							cause: null,
						}),
					)
				}
				return step(page + 1, next)
			}),
		)
	return step(0, new Set()).pipe(Effect.map((claimed) => Arr.filter(domains, (d) => claimed.has(d))))
}

const RoleMappingList = Schema.Struct({ data: Schema.Array(RoleMappingJson) })

export interface ClerkSsoRoleMapping {
	readonly groupId: string
	readonly groupName: string | null
	readonly roleKey: string
}

const BypassUserJson = Schema.Struct({
	user_id: Schema.String,
	public_user_data: Schema.optionalKey(
		Schema.NullOr(Schema.Struct({ identifier: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
	),
})
const BypassUserList = Schema.Array(BypassUserJson)

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

const toConnection = (c: EnterpriseConnection): ClerkSsoConnection => ({
	id: c.id,
	name: c.name,
	provider: c.provider,
	domains: c.domains,
	organizationId: c.organizationId,
	active: c.active,
	createdAt: c.createdAt,
	saml:
		c.samlConnection === null
			? null
			: {
					acsUrl: c.samlConnection.acsUrl ?? null,
					spEntityId: c.samlConnection.spEntityId ?? null,
					spMetadataUrl: c.samlConnection.spMetadataUrl ?? null,
					idpMetadataUrl: c.samlConnection.idpMetadataUrl || null,
					idpSsoUrl: c.samlConnection.idpSsoUrl || null,
					idpEntityId: c.samlConnection.idpEntityId || null,
					certificateExpiresAt: c.samlConnection.idpCertificateExpiresAt ?? null,
				},
	oidc:
		c.oauthConfig === null
			? null
			: { discoveryUrl: c.oauthConfig.discoveryUrl ?? null, clientId: c.oauthConfig.clientId ?? null },
})

const samlParams = (saml: NonNullable<ClerkSsoConnectionInput["saml"]>): EnterpriseConnectionSamlParams => {
	if (saml.metadataUrl !== undefined) return { idpMetadataUrl: saml.metadataUrl }
	const params: EnterpriseConnectionSamlParams = { idpSsoUrl: saml.ssoUrl, idpEntityId: saml.entityId }
	if (saml.certificate !== undefined) params.idpCertificates = [saml.certificate]
	return params
}

const createParams = (
	orgId: OrgId,
	provider: SsoProvider,
	input: ClerkSsoConnectionInput,
): CreateEnterpriseConnectionParams => {
	const params: CreateEnterpriseConnectionParams = {
		name: input.name,
		domains: [...input.domains],
		organizationId: orgId,
		provider,
		// Never live on create: the admin enforces it once a sign-in works.
		active: false,
		allowOrganizationAccountLinking: true,
	}
	if (input.saml !== undefined) params.saml = samlParams(input.saml)
	if (input.oidc !== undefined) params.oidc = input.oidc
	return params
}

/** Clerk's update body: only what the caller set, so an omitted secret keeps the stored one. */
const updateParams = (
	input: Partial<ClerkSsoConnectionInput> & { readonly active?: boolean },
): UpdateEnterpriseConnectionParams => {
	const params: UpdateEnterpriseConnectionParams = {}
	if (input.name !== undefined) params.name = input.name
	if (input.domains !== undefined) params.domains = [...input.domains]
	if (input.active !== undefined) params.active = input.active
	if (input.saml !== undefined) params.saml = samlParams(input.saml)
	if (input.oidc !== undefined) params.oidc = input.oidc
	return params
}

/** Clerk's error body is `{ errors: [{ message, long_message }] }`; the long message is user-facing. */
const clerkErrorMessage = (body: unknown): string | null => {
	if (!Predicate.isObject(body) || !Predicate.hasProperty(body, "errors") || !Arr.isArray(body.errors)) {
		return null
	}
	const first: unknown = body.errors[0]
	if (!Predicate.isObject(first)) return null
	if (Predicate.hasProperty(first, "long_message") && Predicate.isString(first.long_message)) {
		return first.long_message
	}
	return Predicate.hasProperty(first, "message") && Predicate.isString(first.message) ? first.message : null
}

const make = Effect.gen(function* () {
	const env = yield* Env
	const httpClient = yield* HttpClient.HttpClient
	const clerk: ClerkClient | null = clerkModeClient(env) ?? null
	const secret = Option.getOrNull(env.CLERK_SECRET_KEY)

	const notConfigured = (operation: string) =>
		new ClerkRequestError({ operation, message: "Clerk is not configured", status: null, cause: null })

	const sdk = <A>(
		operation: string,
		attributes: Readonly<Record<string, string | number | boolean>>,
		run: (client: ClerkClient) => Promise<A>,
	): Effect.Effect<A, ClerkRequestError> =>
		clerk === null
			? Effect.fail(notConfigured(operation))
			: clerkRequest(operation, attributes, () => run(clerk))

	/** One raw Backend API call: JSON in, JSON out, Clerk's message kept on a non-2xx. */
	const raw = <S extends Schema.Top = typeof Schema.Unknown>(
		operation: string,
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		path: string,
		options: { readonly body?: unknown; readonly decode?: S } = {},
	): Effect.Effect<S["Type"] | undefined, ClerkRequestError, S["DecodingServices"]> =>
		Effect.gen(function* () {
			if (secret === null) return yield* notConfigured(operation)
			const base = HttpClientRequest.make(method)(`${CLERK_API_URL}${path}`).pipe(
				HttpClientRequest.bearerToken(Redacted.value(secret)),
				HttpClientRequest.setHeader("Clerk-API-Version", CLERK_API_VERSION),
				HttpClientRequest.acceptJson,
			)
			const request =
				options.body === undefined ? base : HttpClientRequest.bodyJsonUnsafe(base, options.body)
			const response = yield* httpClient.execute(request)
			const body: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => null))
			if (response.status >= 300) {
				return yield* new ClerkRequestError({
					operation,
					message: clerkErrorMessage(body) ?? `Clerk answered ${response.status}`,
					status: response.status,
					cause: null,
				})
			}
			if (options.decode === undefined) return undefined
			return yield* Schema.decodeUnknownEffect(options.decode)(body)
		}).pipe(
			Effect.catchTags({
				HttpClientError: (cause) =>
					Effect.fail(
						new ClerkRequestError({ operation, message: cause.message, status: null, cause }),
					),
				SchemaError: () =>
					Effect.fail(
						new ClerkRequestError({
							operation,
							message: "Clerk answered in an unexpected shape",
							status: null,
							// The decode error can quote the body, which may hold a SCIM key: not kept.
							cause: null,
						}),
					),
			}),
			Effect.timeoutOrElse({
				duration: CLERK_REQUEST_TIMEOUT,
				orElse: () =>
					Effect.fail(
						new ClerkRequestError({
							operation,
							message: "Clerk timed out",
							status: null,
							cause: null,
						}),
					),
			}),
			Effect.withSpan(operation, {
				kind: "client",
				attributes: { "peer.service": "clerk", "http.request.method": method },
			}),
		)

	const directory = (operation: string, method: "GET" | "POST" | "PATCH", path: string, body?: unknown) =>
		raw(operation, method, path, { body, decode: DirectoryJson }).pipe(
			Effect.filterOrFail(
				(d): d is ClerkSsoDirectory => d !== undefined,
				() =>
					new ClerkRequestError({
						operation,
						message: "Clerk sent no directory",
						status: null,
						cause: null,
					}),
			),
		)

	const api: ClerkSsoGatewayApi = {
		available: clerk !== null && secret !== null,
		listRoles: sdk("Clerk.organizationRoles.list", {}, (c) =>
			c.organizationRoles.getOrganizationRoleList({ limit: 100 }),
		).pipe(Effect.map((page) => Arr.map(page.data, (role) => ({ id: role.id, key: role.key })))),
		ensureOrgDomain: (orgId, domain) =>
			sdk("Clerk.organizations.createOrganizationDomain", { orgId }, (c) =>
				c.organizations.createOrganizationDomain({
					organizationId: orgId,
					name: domain,
					enrollmentMode: "manual_invitation",
					verified: true,
				}),
			).pipe(
				Effect.map((d) => d.id),
				// Already on the org (the Domains tab added it): reuse that one.
				Effect.catchIf(
					(error) => error.status === 422 || error.status === 409 || error.status === 400,
					(error) =>
						sdk("Clerk.organizations.getOrganizationDomainList", { orgId }, async (c) => {
							const all: Array<{ readonly id: string; readonly name: string }> = []
							for (let offset = 0; offset < 1_000; offset += 100) {
								const page = await c.organizations.getOrganizationDomainList({
									organizationId: orgId,
									limit: 100,
									offset,
								})
								all.push(...page.data)
								if (page.data.length < 100) break
							}
							return { data: all }
						}).pipe(
							Effect.flatMap((page) => {
								const found = Arr.findFirst(page.data, (d) => d.name === domain)
								return Option.match(found, {
									onNone: () => Effect.fail(error),
									onSome: (d) => Effect.succeed(d.id),
								})
							}),
						),
				),
			),
		verifyOrgDomainOwnership: (orgId, domainId) =>
			raw(
				"Clerk.organizationDomains.verifyOwnership",
				"POST",
				`/organizations/${encodeURIComponent(orgId)}/domains/${encodeURIComponent(domainId)}/verify_ownership`,
			).pipe(Effect.asVoid),
		deleteOrgDomain: (orgId, domainId) =>
			sdk("Clerk.organizations.deleteOrganizationDomain", { orgId }, (c) =>
				c.organizations.deleteOrganizationDomain({ organizationId: orgId, domainId }),
			).pipe(Effect.asVoid),
		getConnection: (id) =>
			sdk("Clerk.enterpriseConnections.get", {}, (c) =>
				c.enterpriseConnections.getEnterpriseConnection(id),
			).pipe(Effect.map(toConnection)),
		createConnection: (orgId, provider, input) =>
			sdk("Clerk.enterpriseConnections.create", { orgId, provider }, (c) =>
				c.enterpriseConnections.createEnterpriseConnection(createParams(orgId, provider, input)),
			).pipe(Effect.map(toConnection)),
		updateConnection: (id, input) =>
			sdk("Clerk.enterpriseConnections.update", {}, (c) =>
				c.enterpriseConnections.updateEnterpriseConnection(id, updateParams(input)),
			).pipe(Effect.map(toConnection)),
		deleteConnection: (id) =>
			sdk("Clerk.enterpriseConnections.delete", {}, (c) =>
				c.enterpriseConnections.deleteEnterpriseConnection(id),
			).pipe(Effect.asVoid),
		createDirectory: (connectionId, provider) =>
			directory("Clerk.directories.create", "POST", "/directories", {
				enterprise_connection_id: connectionId,
				provider,
				name: "Maple SCIM",
			}),
		getDirectory: (id) =>
			directory("Clerk.directories.get", "GET", `/directories/${encodeURIComponent(id)}`),
		updateDirectory: (id, patch) =>
			directory("Clerk.directories.update", "PATCH", `/directories/${encodeURIComponent(id)}`, patch),
		rotateDirectoryKey: (id) =>
			directory(
				"Clerk.directories.rotateApiKey",
				"POST",
				`/directories/${encodeURIComponent(id)}/rotate_api_key`,
			),
		deleteDirectory: (id) =>
			raw("Clerk.directories.delete", "DELETE", `/directories/${encodeURIComponent(id)}`).pipe(
				Effect.asVoid,
			),
		domainsClaimedElsewhere: (connectionId, domains) =>
			domains.length === 0
				? Effect.succeed([])
				: scanClaimedDomains(
						(offset) =>
							sdk("Clerk.enterpriseConnections.list", { offset }, (c) =>
								c.enterpriseConnections.getEnterpriseConnectionList({
									limit: CONNECTION_PAGE_SIZE,
									offset,
								}),
							),
						connectionId,
						domains,
					),
		isDeprovisioned: (userId) =>
			raw("Clerk.users.get", "GET", `/users/${encodeURIComponent(userId)}`, { decode: UserFlags }).pipe(
				Effect.map((user) => user?.deprovisioned === true),
				Effect.catchIf(
					(e) => e.status === 404,
					() => Effect.succeed(true),
				),
			),
		isMember: (orgId, userId) =>
			sdk("Clerk.organizations.getOrganizationMembershipList", { orgId }, (c) =>
				c.organizations.getOrganizationMembershipList({
					organizationId: orgId,
					userId: [userId],
					limit: 1,
				}),
			).pipe(Effect.map((page) => page.data.length > 0)),
		verifiedEmailDomains: (userId) =>
			sdk("Clerk.users.getUser", {}, (c) => c.users.getUser(userId)).pipe(
				Effect.map((user) =>
					Arr.flatMap(user.emailAddresses, (e) =>
						e.verification?.status === "verified"
							? Option.toArray(
									Option.map(Arr.last(Str.split(e.emailAddress, "@")), Str.toLowerCase),
								)
							: [],
					),
				),
			),
		listRoleMappings: (directoryId) =>
			raw(
				"Clerk.directories.listGroupRoleMappings",
				"GET",
				`/directories/${encodeURIComponent(directoryId)}/group_role_mappings`,
				{
					decode: RoleMappingList,
				},
			).pipe(
				Effect.map((list) =>
					Arr.map(Arr.sort(list?.data ?? [], byPrecedence), (m) => ({
						groupId: m.directory_group_id ?? m.scim_group_id ?? "",
						groupName: m.directory_group_display_name ?? null,
						roleKey: m.role.key,
					})),
				),
			),
		replaceRoleMappings: (directoryId, mappings) =>
			raw(
				"Clerk.directories.replaceGroupRoleMappings",
				"PUT",
				`/directories/${encodeURIComponent(directoryId)}/group_role_mappings`,
				{
					body: {
						mappings: Arr.map(mappings, (m) => ({
							directory_group_id: m.groupId,
							role_id: m.roleId,
						})),
					},
				},
			).pipe(Effect.asVoid),
		listBypassUsers: (connectionId) =>
			raw(
				"Clerk.ssoBypassAllowlist.list",
				"GET",
				`/sso_bypass_allowlist_users?enterprise_connection_id=${encodeURIComponent(connectionId)}`,
				{
					decode: BypassUserList,
				},
			).pipe(
				Effect.map((list) =>
					Arr.map(list ?? [], (u) => ({
						userId: u.user_id,
						identifier: u.public_user_data?.identifier ?? null,
					})),
				),
			),
		addBypassUser: (userId) =>
			raw("Clerk.ssoBypassAllowlist.create", "POST", "/sso_bypass_allowlist_users", {
				body: { user_id: userId },
			}).pipe(Effect.asVoid),
		removeBypassUser: (userId) =>
			raw(
				"Clerk.ssoBypassAllowlist.delete",
				"DELETE",
				`/sso_bypass_allowlist_users/${encodeURIComponent(userId)}`,
			).pipe(Effect.asVoid),
	}
	return api
})

export class ClerkSsoGateway extends Context.Service<ClerkSsoGateway, ClerkSsoGatewayApi>()(
	"@maple/backend/services/org/enterprise-sso/ClerkSsoGateway",
	{ make },
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
