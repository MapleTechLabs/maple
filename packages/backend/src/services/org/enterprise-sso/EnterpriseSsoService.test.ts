import { afterEach, assert, describe, it } from "@effect/vitest"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { Array as Arr, ConfigProvider, Effect, Exit, Layer, Option, Schema, String as Str } from "effect"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId, SsoConnectionRequest, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { ClerkRequestError } from "@maple/backend/services/auth/clerk-request"
import { ClerkSsoGateway, type ClerkSsoConnection, type ClerkSsoDirectory } from "./ClerkSsoGateway"
import { DnsTxtResolver } from "./DnsTxtResolver"
import { EnterpriseSsoService } from "./EnterpriseSsoService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_acme")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const ADMIN = Schema.decodeSync(UserId)("user_admin")
const BREAK_GLASS = Schema.decodeSync(UserId)("user_breakglass")

/** Clerk as far as the SSO settings use it, kept in memory so each call's effect can be asserted. */
interface FakeClerk {
	connections: Map<string, ClerkSsoConnection>
	directories: Map<string, ClerkSsoDirectory & { connectionId: string }>
	verifiedDomains: Array<string>
	mappings: Map<string, Array<{ groupId: string; roleId: string }>>
	bypass: Array<string>
	/** Org members, and each user's verified email domains. */
	members: Set<string>
	emailDomains: Map<string, Array<string>>
	nextId: number
	/** The next `createConnection` fails with this Clerk status and message. */
	rejectCreate: { status: number; message: string } | null
}

const ROLES = [
	{ id: "role_admin", key: "org:admin" },
	{ id: "role_engineer", key: "org:engineer" },
	{ id: "role_member", key: "org:member" },
	{ id: "role_analyst", key: "org:analyst" },
]

const fakeClerk = (): FakeClerk => ({
	connections: new Map(),
	directories: new Map(),
	verifiedDomains: [],
	mappings: new Map(),
	bypass: [],
	members: new Set(["user_admin", "user_breakglass", "user_contractor"]),
	emailDomains: new Map([
		["user_breakglass", ["acme.com"]],
		["user_contractor", ["gmail.com"]],
		["user_outsider", ["acme.com"]],
	]),
	nextId: 1,
	rejectCreate: null,
})

const notFound = (operation: string) =>
	new ClerkRequestError({ operation, message: "not found", status: 404, cause: null })

const gatewayLayer = (clerk: FakeClerk) =>
	Layer.succeed(ClerkSsoGateway, {
		available: true,
		listRoles: Effect.succeed(ROLES),
		ensureOrgDomain: (orgId, domain) => Effect.succeed(`dmn_${orgId}_${domain}`),
		verifyOrgDomainOwnership: (_orgId, domainId) =>
			Effect.sync(() => void clerk.verifiedDomains.push(domainId)),
		deleteOrgDomain: () => Effect.void,
		getConnection: (id) => {
			const c = clerk.connections.get(id)
			return c === undefined ? Effect.fail(notFound("get")) : Effect.succeed(c)
		},
		createConnection: (orgId, provider, input) =>
			Effect.suspend(() => {
				if (clerk.rejectCreate !== null) {
					const { status, message } = clerk.rejectCreate
					return Effect.fail(
						new ClerkRequestError({ operation: "create", message, status, cause: null }),
					)
				}
				const id = `ent_${clerk.nextId++}`
				const c: ClerkSsoConnection = {
					id,
					name: input.name,
					provider,
					domains: input.domains,
					organizationId: orgId,
					active: false,
					createdAt: 1_760_000_000_000,
					saml: Str.startsWith("saml_")(provider)
						? {
								acsUrl: `https://clerk.test/v1/saml/acs/${id}`,
								spEntityId: `https://clerk.test/saml/${id}`,
								spMetadataUrl: `https://clerk.test/v1/saml/metadata/${id}`,
								idpMetadataUrl: input.saml?.metadataUrl ?? null,
								idpSsoUrl: input.saml?.ssoUrl ?? null,
								idpEntityId: input.saml?.entityId ?? null,
								certificateExpiresAt: null,
							}
						: null,
					oidc:
						input.oidc === undefined
							? null
							: { discoveryUrl: input.oidc.discoveryUrl, clientId: input.oidc.clientId },
				}
				clerk.connections.set(id, c)
				return Effect.succeed(c)
			}),
		updateConnection: (id, input) =>
			Effect.suspend(() => {
				const c = clerk.connections.get(id)
				if (c === undefined) return Effect.fail(notFound("update"))
				const next = {
					...c,
					name: input.name ?? c.name,
					domains: input.domains ?? c.domains,
					active: input.active ?? c.active,
				}
				clerk.connections.set(id, next)
				return Effect.succeed(next)
			}),
		deleteConnection: (id) => Effect.sync(() => void clerk.connections.delete(id)),
		createDirectory: (connectionId, provider) =>
			Effect.sync(() => {
				const id = `dir_${clerk.nextId++}`
				const d = {
					id,
					connectionId,
					endpoint_url: `https://scim.clerk.test/${id}/${provider}`,
					enabled: true,
					paused: false,
					group_role_mapping_enabled: false,
					created_at: 1_760_000_000_000,
					api_key: `scim_${clerk.nextId++}`,
				}
				clerk.directories.set(id, d)
				return d
			}),
		getDirectory: (id) => {
			const d = clerk.directories.get(id)
			return d === undefined ? Effect.fail(notFound("dir")) : Effect.succeed({ ...d, api_key: null })
		},
		updateDirectory: (id, patch) =>
			Effect.suspend(() => {
				const d = clerk.directories.get(id)
				if (d === undefined) return Effect.fail(notFound("dir"))
				const next = { ...d, ...patch }
				clerk.directories.set(id, next)
				return Effect.succeed({ ...next, api_key: null })
			}),
		rotateDirectoryKey: (id) =>
			Effect.suspend(() => {
				const d = clerk.directories.get(id)
				if (d === undefined) return Effect.fail(notFound("dir"))
				const next = { ...d, api_key: `scim_${clerk.nextId++}` }
				clerk.directories.set(id, next)
				return Effect.succeed(next)
			}),
		deleteDirectory: (id) => Effect.sync(() => void clerk.directories.delete(id)),
		listRoleMappings: (directoryId) =>
			Effect.sync(() =>
				Arr.map(clerk.mappings.get(directoryId) ?? [], (m) => ({
					groupId: m.groupId,
					groupName: null,
					roleKey: Option.getOrElse(
						Option.map(
							Arr.findFirst(ROLES, (r) => r.id === m.roleId),
							(r) => r.key,
						),
						() => "unknown",
					),
				})),
			),
		replaceRoleMappings: (directoryId, mappings) =>
			Effect.sync(() => void clerk.mappings.set(directoryId, [...mappings])),
		isMember: (_orgId, userId) => Effect.sync(() => clerk.members.has(userId)),
		verifiedEmailDomains: (userId) => Effect.sync(() => clerk.emailDomains.get(userId) ?? []),
		listBypassUsers: () =>
			Effect.sync(() =>
				Arr.map(clerk.bypass, (userId) => ({ userId, identifier: `${userId}@acme.com` })),
			),
		addBypassUser: (userId) => Effect.sync(() => void clerk.bypass.push(userId)),
		removeBypassUser: (userId) =>
			Effect.sync(() => void (clerk.bypass = Arr.filter(clerk.bypass, (u) => u !== userId))),
	})

/** Published TXT records by name. */
const dnsLayer = (records: Map<string, Array<string>>) =>
	Layer.succeed(DnsTxtResolver, { lookupTxt: (name) => Effect.succeed(records.get(name) ?? []) })

const die = () => Effect.die(new Error("not used by this test"))

const autumnStub = (entitled: boolean) =>
	Layer.succeed(AutumnClient, {
		getOrCreateCustomer: () =>
			Effect.succeed<AutumnResult>({
				statusCode: 200,
				response: {
					id: ORG,
					flags: entitled ? { enterprise_sso: { featureId: "enterprise_sso" } } : {},
				},
			}),
		aggregateEvents: die,
		attach: die,
		previewAttach: die,
		openCustomerPortal: die,
		listPlans: die,
		applyReward: die,
		cancelPlans: die,
		updateCustomerBillingControls: die,
		updateCustomerName: die,
	})

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.test",
	}),
)

const run = <A, E>(
	testDb: TestDb,
	world: { clerk: FakeClerk; dns: Map<string, Array<string>>; entitled: boolean },
	effect: Effect.Effect<A, E, EnterpriseSsoService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(EnterpriseSsoService, EnterpriseSsoService.make).pipe(
				Layer.provide(
					Layer.mergeAll(
						autumnStub(world.entitled),
						EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive)),
						BillingCustomerResolver.standalone,
						gatewayLayer(world.clerk),
						dnsLayer(world.dns),
					),
				),
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
				Layer.provide(config),
			),
		),
	)

const samlRequest = (domains: Array<string>) =>
	new SsoConnectionRequest({
		name: "Acme Okta",
		provider: "saml_okta",
		domains,
		saml: { metadataUrl: "https://acme.okta.com/app/abc/sso/saml/metadata" },
	})

/** Adds a domain and publishes its challenge, the way an admin would at their DNS host. */
const verifiedDomain = (dns: Map<string, Array<string>>, domain: string) =>
	Effect.gen(function* () {
		const sso = yield* EnterpriseSsoService
		const added = yield* sso.addDomain(ORG, ADMIN, domain)
		const row = Arr.findFirst(added.domains, (d) => d.domain === domain)
		assert.isTrue(Option.isSome(row))
		if (Option.isSome(row)) dns.set(row.value.recordName, ["v=spf1 -all", row.value.recordValue])
		return yield* sso.verifyDomain(ORG, domain)
	})

describe("EnterpriseSsoService", () => {
	it.effect("verifies a domain by TXT, connects an IdP inactive, enforces it, and provisions SCIM", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService

				const added = yield* sso.addDomain(ORG, ADMIN, "  Acme.COM. ")
				assert.deepStrictEqual(
					Arr.map(added.domains, (d) => [d.domain, d.status, d.recordName]),
					[["acme.com", "pending", "_maple-challenge.acme.com"]],
				)
				assert.match(added.domains[0]?.recordValue ?? "", /^maple-domain-verification=[0-9a-f]{32}$/)

				// No record published yet: refused, and nothing reaches Clerk.
				const early = yield* sso.verifyDomain(ORG, "acme.com").pipe(Effect.flip)
				assert.strictEqual(early._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
				assert.deepStrictEqual(world.clerk.verifiedDomains, [])

				// Another org's challenge does not prove this org's claim.
				world.dns.set("_maple-challenge.acme.com", ["maple-domain-verification=someone-else"])
				const wrong = yield* sso.verifyDomain(ORG, "acme.com").pipe(Effect.flip)
				assert.strictEqual(wrong._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")

				const verified = yield* verifiedDomain(world.dns, "acme.com")
				assert.strictEqual(verified.domains[0]?.status, "verified")
				assert.deepStrictEqual(world.clerk.verifiedDomains, ["dmn_org_acme_acme.com"])

				// Only verified domains may route sign-ins to an IdP.
				yield* sso.addDomain(ORG, ADMIN, "acme.io")
				const unverified = yield* sso
					.createConnection(ORG, ADMIN, samlRequest(["acme.com", "acme.io"]))
					.pipe(Effect.flip)
				assert.strictEqual(unverified._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
				assert.strictEqual(world.clerk.connections.size, 0)

				const connected = yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				assert.strictEqual(connected.connection?.enforced, false)
				assert.strictEqual(connected.connection?.protocol, "saml")
				assert.match(connected.connection?.acsUrl ?? "", /^https:\/\/clerk\.test\/v1\/saml\/acs\//)

				const again = yield* sso
					.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					.pipe(Effect.flip)
				assert.strictEqual(again._tag, "@maple/http/enterprise-sso/EnterpriseSsoConflictError")

				// A domain in use by the connection cannot be dropped out from under it.
				const inUse = yield* sso.removeDomain(ORG, "acme.com").pipe(Effect.flip)
				assert.strictEqual(inUse._tag, "@maple/http/enterprise-sso/EnterpriseSsoConflictError")

				const enforced = yield* sso.setEnforcement(ORG, true)
				assert.strictEqual(enforced.connection?.enforced, true)

				const withBypass = yield* sso.addBypassUser(ORG, BREAK_GLASS)
				assert.deepStrictEqual(
					Arr.map(withBypass.bypassUsers, (u) => u.userId),
					[BREAK_GLASS],
				)

				const created = yield* sso.createDirectory(ORG)
				assert.match(created.token, /^scim_/)
				assert.match(created.document.directory?.endpointUrl ?? "", /\/okta$/)
				assert.isFalse(created.document.directory?.paused ?? true)
				// The token is shown once: the stored row holds only Clerk's directory id.
				const row = yield* Effect.promise(() =>
					queryFirstRow<Record<string, unknown>>(
						testDb,
						"SELECT * FROM org_sso_connections WHERE org_id = 'org_acme'",
					),
				)
				assert.isFalse(Str.includes(created.token)(JSON.stringify(row)))

				const rotated = yield* sso.rotateDirectoryToken(ORG)
				assert.notStrictEqual(rotated.token, created.token)

				// Groups arrive from the IdP over SCIM webhooks, then admins map them to roles.
				const directoryId = [...world.clerk.directories.keys()][0] ?? ""
				const applied = yield* sso.applyDirectoryGroup({
					directoryId,
					groupId: "grp_admins",
					displayName: "Maple Admins",
					updatedAt: 1,
					deleted: false,
				})
				assert.strictEqual(applied, "applied")
				yield* sso.applyDirectoryGroup({
					directoryId,
					groupId: "grp_fin",
					displayName: "Finance",
					updatedAt: 1,
					deleted: false,
				})

				const mapped = yield* sso.setRoleMappings(ORG, [
					{ groupId: "grp_admins", role: "org:admin" },
					{ groupId: "grp_fin", role: "org:analyst" },
				])
				assert.deepStrictEqual(world.clerk.mappings.get(directoryId), [
					{ groupId: "grp_admins", roleId: "role_admin" },
					{ groupId: "grp_fin", roleId: "role_analyst" },
				])
				assert.isTrue(world.clerk.directories.get(directoryId)?.group_role_mapping_enabled)
				assert.deepStrictEqual(
					Arr.map(mapped.roleMappings, (m) => [m.groupName, m.role]),
					[
						["Maple Admins", "org:admin"],
						["Finance", "org:analyst"],
					],
				)
				assert.deepStrictEqual(
					Arr.map(mapped.groups, (g) => g.displayName),
					["Finance", "Maple Admins"],
				)

				const duplicate = yield* sso
					.setRoleMappings(ORG, [
						{ groupId: "grp_fin", role: "org:admin" },
						{ groupId: "grp_fin", role: "org:analyst" },
					])
					.pipe(Effect.flip)
				assert.strictEqual(duplicate._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")

				const paused = yield* sso.setDirectoryState(ORG, true)
				assert.isTrue(paused.directory?.paused)

				// Removing the connection takes the directory and its groups with it.
				const removed = yield* sso.deleteConnection(ORG)
				assert.isNull(removed.connection)
				assert.isNull(removed.directory)
				assert.deepStrictEqual(removed.groups, [])
				assert.strictEqual(world.clerk.connections.size, 0)
				assert.strictEqual(world.clerk.directories.size, 0)
				const groupRows = yield* Effect.promise(() =>
					queryFirstRow<{ n: number }>(
						testDb,
						"SELECT count(*)::int AS n FROM org_directory_groups",
					),
				)
				assert.strictEqual(groupRows?.n, 0)
			}),
		)
	})

	it.effect("refuses every setup write without the Enterprise feature, but lets an org relax SSO", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return Effect.gen(function* () {
			// Set up while entitled, then the plan lapses.
			yield* run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					yield* sso.setEnforcement(ORG, true)
				}),
			)
			world.entitled = false
			yield* run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					const doc = yield* sso.get(ORG)
					assert.isFalse(doc.entitled)
					assert.strictEqual(doc.connection?.enforced, true)

					for (const write of [
						sso.addDomain(ORG, ADMIN, "acme.io"),
						sso.createDirectory(ORG),
						sso.setEnforcement(ORG, true),
					]) {
						const error = yield* write.pipe(Effect.flip)
						assert.strictEqual(
							error._tag,
							"@maple/http/enterprise-sso/EnterpriseSsoNotEntitledError",
						)
					}
					const relaxed = yield* sso.setEnforcement(ORG, false)
					assert.strictEqual(relaxed.connection?.enforced, false)
				}),
			)
		})
	})

	it.effect("passes Clerk's validation message through and leaves nothing behind", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				world.clerk.rejectCreate = {
					status: 422,
					message: "The IdP metadata URL could not be fetched.",
				}
				const error = yield* sso
					.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					.pipe(Effect.flip)
				assert.strictEqual(error._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
				assert.strictEqual(error.message, "The IdP metadata URL could not be fetched.")
				assert.isNull((yield* sso.get(ORG)).connection)

				const oidcWithoutSecret = yield* sso
					.createConnection(
						ORG,
						ADMIN,
						new SsoConnectionRequest({
							name: "Acme OIDC",
							provider: "oidc_custom",
							domains: ["acme.com"],
							oidc: {
								discoveryUrl: "https://id.acme.com/.well-known/openid-configuration",
								clientId: "maple",
							},
						}),
					)
					.pipe(Effect.flip)
				assert.strictEqual(
					oidcWithoutSecret._tag,
					"@maple/http/enterprise-sso/EnterpriseSsoInvalidError",
				)

				const notADomain = yield* sso.addDomain(ORG, ADMIN, "https://acme.com/path").pipe(Effect.flip)
				assert.strictEqual(notADomain._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
			}),
		)
	})

	it.effect(
		"ignores directory groups for directories this region does not hold, and scopes bypass removal",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					const outcome = yield* sso.applyDirectoryGroup({
						directoryId: "dir_elsewhere",
						groupId: "grp_1",
						displayName: "Admins",
						updatedAt: 1,
						deleted: false,
					})
					assert.strictEqual(outcome, "not_here")

					// An org with no connection has no bypass list to edit.
					const exit = yield* sso.removeBypassUser(OTHER_ORG, BREAK_GLASS).pipe(Effect.exit)
					assert.isTrue(Exit.isFailure(exit))

					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					const missing = yield* sso.removeBypassUser(ORG, BREAK_GLASS).pipe(Effect.flip)
					assert.strictEqual(missing._tag, "@maple/http/enterprise-sso/EnterpriseSsoNotFoundError")
				}),
			)
		},
	)

	it.effect(
		"scopes the instance-wide bypass list to this org's members on its domains, and clears it on delete",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))

					// Someone else's member, even with an email on this domain, cannot be exempted from here.
					const outsider = yield* sso
						.addBypassUser(ORG, Schema.decodeSync(UserId)("user_outsider"))
						.pipe(Effect.flip)
					assert.strictEqual(outsider._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
					// A member whose email is on another domain would land on another org's connection.
					const contractor = yield* sso
						.addBypassUser(ORG, Schema.decodeSync(UserId)("user_contractor"))
						.pipe(Effect.flip)
					assert.strictEqual(
						contractor._tag,
						"@maple/http/enterprise-sso/EnterpriseSsoInvalidError",
					)
					assert.deepStrictEqual(world.clerk.bypass, [])

					yield* sso.addBypassUser(ORG, BREAK_GLASS)
					assert.deepStrictEqual(world.clerk.bypass, [BREAK_GLASS])
					yield* sso.deleteConnection(ORG)
					assert.deepStrictEqual(world.clerk.bypass, [])
				}),
			)
		},
	)

	it.effect("lets one of two concurrent SCIM set-ups win, and drops the loser's directory", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				const [a, b] = yield* Effect.all(
					[sso.createDirectory(ORG).pipe(Effect.exit), sso.createDirectory(ORG).pipe(Effect.exit)],
					{
						concurrency: "unbounded",
					},
				)
				assert.strictEqual(Arr.filter([a, b], Exit.isSuccess).length, 1)
				assert.strictEqual(world.clerk.directories.size, 1)
			}),
		)
	})

	it.effect("reads a connection deleted in Clerk as not set up, and never revives a deleted group", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				yield* sso.createDirectory(ORG)
				const directoryId = [...world.clerk.directories.keys()][0] ?? ""
				const group = { directoryId, groupId: "grp_1", displayName: "Admins" }

				yield* sso.applyDirectoryGroup({ ...group, updatedAt: 10, deleted: false })
				yield* sso.applyDirectoryGroup({ ...group, updatedAt: 20, deleted: true })
				// A redelivered older update arrives after the deletion.
				yield* sso.applyDirectoryGroup({ ...group, updatedAt: 15, deleted: false })
				assert.deepStrictEqual((yield* sso.get(ORG)).groups, [])

				world.clerk.directories.clear()
				world.clerk.connections.clear()
				const doc = yield* sso.get(ORG)
				assert.isNull(doc.connection)
				assert.isNull(doc.directory)
			}),
		)
	})
})
