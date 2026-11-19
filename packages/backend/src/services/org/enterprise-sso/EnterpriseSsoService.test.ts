import { afterEach, assert, describe, it } from "@effect/vitest"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { Array as Arr, ConfigProvider, Effect, Exit, Layer, Option, Schema, String as Str } from "effect"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId, SsoConnectionRequest, SsoSamlSettings, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { ClerkRequestError } from "@maple/auth"
import { ClerkSsoGateway, type ClerkSsoConnection, type ClerkSsoDirectory } from "./ClerkSsoGateway"
import { DnsLookupError, DnsTxtResolver } from "@maple/backend/platform/DnsTxtResolver"
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
	/** What Clerk says about a deprovisioned user now, or that it cannot be reached. */
	deprovisioned: "yes" | "no" | "unreachable"
	deprovisionLookups: number
	/** Runs while Clerk rotates a key, to change the world mid-request. */
	onRotate: (() => Promise<void>) | null
	emailDomains: Map<string, Array<string>>
	nextId: number
	/** The next `createConnection` fails with this Clerk status and message. */
	rejectCreate: { status: number; message: string } | null
	/** Clerk is down for deletes. */
	failDeletes: boolean
	/** How often the bypass list was read. */
	bypassLookups: number
	/** The IdP settings each connection update carried. */
	updates: Array<{ certificate?: string; metadataUrl?: string; clientSecret?: string }>
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
	deprovisioned: "yes",
	deprovisionLookups: 0,
	onRotate: null,
	members: new Set(["user_admin", "user_breakglass", "user_contractor", "user_dual"]),
	emailDomains: new Map([
		["user_breakglass", ["acme.com"]],
		["user_contractor", ["gmail.com"]],
		["user_outsider", ["acme.com"]],
		["user_dual", ["acme.com", "partner.io"]],
	]),
	nextId: 1,
	rejectCreate: null,
	failDeletes: false,
	bypassLookups: 0,
	updates: [],
})

const notFound = () => new ClerkRequestError({ message: "not found", status: 404, cause: null })

const down = () => new ClerkRequestError({ message: "down", status: 503, cause: null })

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
			return c === undefined ? Effect.fail(notFound()) : Effect.succeed(c)
		},
		createConnection: (orgId, provider, input) =>
			Effect.suspend(() => {
				if (clerk.rejectCreate !== null) {
					const { status, message } = clerk.rejectCreate
					return Effect.fail(new ClerkRequestError({ message, status, cause: null }))
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
							: {
									discoveryUrl: input.oidc.discoveryUrl,
									clientId: input.oidc.clientId,
									redirectUri: "https://clerk.test/v1/oauth_callback",
								},
				}
				clerk.connections.set(id, c)
				return Effect.succeed(c)
			}),
		updateConnection: (id, input) =>
			Effect.suspend(() => {
				const c = clerk.connections.get(id)
				if (c === undefined) return Effect.fail(notFound())
				clerk.updates.push({ ...input.saml, ...input.oidc })
				const next = {
					...c,
					name: input.name ?? c.name,
					domains: input.domains ?? c.domains,
					active: input.active ?? c.active,
				}
				clerk.connections.set(id, next)
				return Effect.succeed(next)
			}),
		// Like Clerk: deleting a connection drops the bypass entries no remaining connection serves.
		deleteConnection: (id) =>
			Effect.suspend(() => {
				if (clerk.failDeletes) return Effect.fail(down())
				clerk.connections.delete(id)
				const served = new Set(Arr.flatMap([...clerk.connections.values()], (c) => c.domains))
				clerk.bypass = Arr.filter(clerk.bypass, (userId) =>
					Arr.some(clerk.emailDomains.get(userId) ?? [], (d) => served.has(d)),
				)
				return Effect.void
			}),
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
			return d === undefined ? Effect.fail(notFound()) : Effect.succeed({ ...d, api_key: null })
		},
		updateDirectory: (id, patch) =>
			Effect.suspend(() => {
				const d = clerk.directories.get(id)
				if (d === undefined) return Effect.fail(notFound())
				const next = { ...d, ...patch }
				clerk.directories.set(id, next)
				return Effect.succeed({ ...next, api_key: null })
			}),
		rotateDirectoryKey: (id) =>
			Effect.suspend(() => {
				const d = clerk.directories.get(id)
				if (d === undefined) return Effect.fail(notFound())
				const next = { ...d, api_key: `scim_${clerk.nextId++}` }
				clerk.directories.set(id, next)
				const hook = clerk.onRotate
				return hook === null ? Effect.succeed(next) : Effect.promise(hook).pipe(Effect.as(next))
			}),
		deleteDirectory: (id) =>
			Effect.suspend(() => {
				if (clerk.failDeletes) return Effect.fail(down())
				clerk.directories.delete(id)
				return Effect.void
			}),
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
		domainsClaimedElsewhere: (connectionId, domains) =>
			Effect.sync(() =>
				Arr.filter(domains, (d) =>
					Arr.some(
						[...clerk.connections.values()],
						(c) => c.id !== connectionId && Arr.contains(c.domains, d),
					),
				),
			),
		isDeprovisioned: () =>
			Effect.suspend(() => {
				clerk.deprovisionLookups++
				return clerk.deprovisioned === "unreachable"
					? Effect.fail(
							new ClerkRequestError({
								message: "down",
								status: 503,
								cause: null,
							}),
						)
					: Effect.succeed(clerk.deprovisioned === "yes")
			}),
		isMember: (_orgId, userId) => Effect.sync(() => clerk.members.has(userId)),
		verifiedEmailDomains: (userId) => Effect.sync(() => clerk.emailDomains.get(userId) ?? []),
		listBypassUsers: () =>
			Effect.sync(() => {
				clerk.bypassLookups++
				return Arr.map(clerk.bypass, (userId) => ({ userId, identifier: `${userId}@acme.com` }))
			}),
		addBypassUser: (userId) => Effect.sync(() => void clerk.bypass.push(userId)),
		removeBypassUser: (userId) =>
			Effect.sync(() => void (clerk.bypass = Arr.filter(clerk.bypass, (u) => u !== userId))),
	})

/** Published TXT records by name. */
/** A step a test runs in the middle of a request, to change the world under it. */
interface MidRequestHook {
	current: (() => Promise<void>) | null
}

/** The resolver cannot be reached while `current` is true. */
interface DnsOutage {
	current: boolean
}

/** Published TXT records by name; `onLookup` runs during the lookup, to change the world mid-request. */
const dnsLayer = (records: Map<string, Array<string>>, onLookup: MidRequestHook, outage: DnsOutage) =>
	Layer.succeed(DnsTxtResolver, {
		lookupTxt: (name) => {
			const found = Effect.suspend(() =>
				outage.current
					? Effect.fail(new DnsLookupError({ recordName: name, message: "SERVFAIL" }))
					: Effect.succeed(records.get(name) ?? []),
			)
			const hook = onLookup.current
			return hook === null ? found : Effect.promise(hook).pipe(Effect.andThen(found))
		},
	})

const die = () => Effect.die(new Error("not used by this test"))

/** `true` holds both add-ons, `"sso-only"` just single sign-on, `false` neither. */
const autumnStub = (entitled: boolean | "sso-only") =>
	Layer.succeed(AutumnClient, {
		getOrCreateCustomer: () =>
			Effect.succeed<AutumnResult>({
				statusCode: 200,
				response: {
					id: ORG,
					flags:
						entitled === false
							? {}
							: entitled === "sso-only"
								? { enterprise_sso: { featureId: "enterprise_sso" } }
								: {
										enterprise_sso: { featureId: "enterprise_sso" },
										enterprise_scim: { featureId: "enterprise_scim" },
									},
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
	world: {
		clerk: FakeClerk
		dns: Map<string, Array<string>>
		entitled: boolean | "sso-only"
		onLookup?: MidRequestHook
		dnsOutage?: DnsOutage
	},
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
						dnsLayer(
							world.dns,
							world.onLookup ?? { current: null },
							world.dnsOutage ?? { current: false },
						),
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
		// Already added earlier in the test: publish the challenge it has.
		const added = yield* sso
			.addDomain(ORG, ADMIN, domain)
			.pipe(
				Effect.catchTag("@maple/http/enterprise-sso/EnterpriseSsoConflictError", () => sso.get(ORG)),
			)
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

				// Adding it again changes nothing and says so.
				const readded = yield* sso.addDomain(ORG, ADMIN, "ACME.com").pipe(Effect.flip)
				assert.strictEqual(readded._tag, "@maple/http/enterprise-sso/EnterpriseSsoConflictError")

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
					assert.isFalse(doc.ssoEntitled)
					assert.isFalse(doc.scimEntitled)
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

				// The challenge name adds 17 characters, so a domain may be at most 236 long.
				const longest = `${Str.repeat(63)("a")}.${Str.repeat(63)("b")}.${Str.repeat(63)("c")}.${Str.repeat(44)("d")}`
				assert.strictEqual(longest.length, 236)
				const fits = yield* sso.addDomain(ORG, ADMIN, longest)
				assert.strictEqual(
					Arr.findFirst(fits.domains, (d) => d.domain === longest).pipe(
						Option.map((d) => d.recordName.length),
						Option.getOrElse(() => 0),
					),
					253,
				)
				// One more character in the last label: every label stays valid, only the total breaks.
				const tooLong = yield* sso.addDomain(ORG, ADMIN, `${longest}x`).pipe(Effect.flip)
				assert.strictEqual(tooLong._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
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

	it.effect("refuses to exempt someone another org's SSO also covers", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				// Another org's connection serves the user's second address.
				world.clerk.connections.set("ent_partner", {
					...[...world.clerk.connections.values()][0],
					id: "ent_partner",
					organizationId: OTHER_ORG,
					domains: ["partner.io"],
				})
				const dual = yield* sso
					.addBypassUser(ORG, Schema.decodeSync(UserId)("user_dual"))
					.pipe(Effect.flip)
				assert.strictEqual(dual._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
				// The refusal does not say which other domains the person holds.
				assert.notMatch(dual.message, /partner\.io/)
				assert.deepStrictEqual(world.clerk.bypass, [])
			}),
		)
	})

	it.effect(
		"recovers from a connection or directory deleted in Clerk: domains removable, set-up repeatable",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.addDomain(ORG, ADMIN, "acme.io")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					yield* sso.createDirectory(ORG)

					// Directory removed in Clerk's dashboard: a new one can be set up.
					world.clerk.directories.clear()
					const again = yield* sso.createDirectory(ORG)
					assert.isNotNull(again.document.directory)
					assert.strictEqual(world.clerk.directories.size, 1)

					// Connection removed in Clerk's dashboard: domains can go, and a new IdP can connect.
					world.clerk.connections.clear()
					world.clerk.directories.clear()
					const removed = yield* sso.removeDomain(ORG, "acme.io")
					assert.deepStrictEqual(
						Arr.map(removed.domains, (d) => d.domain),
						["acme.com"],
					)
					const reconnected = yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					assert.isNotNull(reconnected.connection)
					assert.isNull(reconnected.directory)
				}),
			)
		},
	)

	it.effect("keeps a group deleted when an update arrives with the same timestamp", () => {
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
				yield* sso.applyDirectoryGroup({ ...group, updatedAt: 20, deleted: false })
				assert.deepStrictEqual((yield* sso.get(ORG)).groups, [])
				// A genuinely newer push re-creates it.
				yield* sso.applyDirectoryGroup({ ...group, updatedAt: 30, deleted: false })
				assert.deepStrictEqual(
					Arr.map((yield* sso.get(ORG)).groups, (g) => g.groupId),
					["grp_1"],
				)
			}),
		)
	})

	it.effect("edits a manual SAML connection without asking for the certificate again", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				const manual = (certificate?: string) =>
					new SsoConnectionRequest({
						name: "Acme IdP",
						provider: "saml_custom",
						domains: ["acme.com"],
						saml:
							certificate === undefined
								? new SsoSamlSettings({
										ssoUrl: "https://idp.acme.com/sso",
										entityId: "https://idp.acme.com",
									})
								: new SsoSamlSettings({
										ssoUrl: "https://idp.acme.com/sso",
										entityId: "https://idp.acme.com",
										certificate,
									}),
					})
				const missing = yield* sso.createConnection(ORG, ADMIN, manual()).pipe(Effect.flip)
				assert.strictEqual(missing._tag, "@maple/http/enterprise-sso/EnterpriseSsoInvalidError")
				yield* sso.createConnection(ORG, ADMIN, manual("-----BEGIN CERTIFICATE-----"))
				const renamed = yield* sso.updateConnection(
					ORG,
					new SsoConnectionRequest({ ...manual(), name: "Acme Corp IdP" }),
				)
				assert.strictEqual(renamed.connection?.name, "Acme Corp IdP")
			}),
		)
	})

	it.effect("never removes a break-glass entry another org's SSO also relies on", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				// Another org added the user while they were only on its domain; both now serve them.
				world.clerk.bypass.push("user_dual")
				world.clerk.connections.set("ent_partner", {
					...[...world.clerk.connections.values()][0],
					id: "ent_partner",
					organizationId: OTHER_ORG,
					domains: ["partner.io"],
				})
				const refused = yield* sso
					.removeBypassUser(ORG, Schema.decodeSync(UserId)("user_dual"))
					.pipe(Effect.flip)
				assert.strictEqual(refused._tag, "@maple/http/enterprise-sso/EnterpriseSsoConflictError")
				assert.notMatch(refused.message, /partner\.io/)
				yield* sso.deleteConnection(ORG)
				assert.deepStrictEqual(world.clerk.bypass, ["user_dual"])
			}),
		)
	})

	it.live(
		"sweeps a deprovision only while Clerk still stands behind it, retrying a blip and then failing closed",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					assert.isTrue(yield* sso.confirmDeprovisioned(ADMIN))
					world.clerk.deprovisioned = "no"
					assert.isFalse(yield* sso.confirmDeprovisioned(ADMIN))
					world.clerk.deprovisioned = "unreachable"
					world.clerk.deprovisionLookups = 0
					assert.isTrue(yield* sso.confirmDeprovisioned(ADMIN))
					// One attempt and two retries before it gives up and sweeps.
					assert.strictEqual(world.clerk.deprovisionLookups, 3)
				}),
			)
		},
	)

	it.effect(
		"leaves a domain pending when it is removed and re-added while its TXT record is checked",
		() => {
			const testDb = createTestDb(trackedDbs)
			const onLookup: MidRequestHook = { current: null }
			const world = {
				clerk: fakeClerk(),
				dns: new Map<string, Array<string>>(),
				entitled: true,
				onLookup,
			}
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					const added = yield* sso.addDomain(ORG, ADMIN, "acme.com")
					const record = added.domains[0]
					world.dns.set(record?.recordName ?? "", [record?.recordValue ?? ""])
					// The re-added row carries a new challenge nobody published.
					onLookup.current = () =>
						executeSql(
							testDb,
							"UPDATE org_sso_domains SET challenge = 'maple-domain-verification=new' WHERE domain = 'acme.com'",
						)
					const after = yield* sso.verifyDomain(ORG, "acme.com")
					assert.strictEqual(after.domains[0]?.status, "pending")
				}),
			)
		},
	)

	it.effect(
		"returns a rotated token with its own directory's endpoint even if the binding changes meanwhile",
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
					const first = yield* sso.createDirectory(ORG)
					const firstEndpoint = first.document.directory?.endpointUrl
					// While Clerk rotates, another request swaps in a different directory.
					world.clerk.directories.set("dir_other", {
						id: "dir_other",
						connectionId: "x",
						endpoint_url: "https://scim.clerk.test/dir_other/custom",
						enabled: true,
						paused: false,
						group_role_mapping_enabled: false,
						created_at: 1,
						api_key: null,
					})
					world.clerk.onRotate = () =>
						executeSql(
							testDb,
							"UPDATE org_sso_connections SET clerk_directory_id = 'dir_other' WHERE org_id = 'org_acme'",
						)
					const rotated = yield* sso.rotateDirectoryToken(ORG)
					assert.strictEqual(rotated.document.directory?.endpointUrl, firstEndpoint)
				}),
			)
		},
	)

	it.effect("sells SSO and SCIM separately: the SSO add-on alone connects an IdP but not SCIM", () => {
		const testDb = createTestDb(trackedDbs)
		const world = {
			clerk: fakeClerk(),
			dns: new Map<string, Array<string>>(),
			entitled: "sso-only" as const,
		}
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				const connected = yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				assert.isTrue(connected.ssoEntitled)
				assert.isFalse(connected.scimEntitled)
				const scim = yield* sso.createDirectory(ORG).pipe(Effect.flip)
				assert.strictEqual(scim._tag, "@maple/http/enterprise-sso/EnterpriseSsoNotEntitledError")
				assert.match(scim.message, /SCIM provisioning is a \$100\/month add-on/)
				assert.strictEqual(world.clerk.directories.size, 0)
			}),
		)
	})

	it.effect("checks a domain's TXT record again before a connection is created or required", () => {
		const testDb = createTestDb(trackedDbs)
		const dnsOutage = { current: false }
		const world = {
			clerk: fakeClerk(),
			dns: new Map<string, Array<string>>(),
			entitled: true,
			dnsOutage,
		}
		const RECORD = "_maple-challenge.acme.com"
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				yield* verifiedDomain(world.dns, "acme.com")
				const published = world.dns.get(RECORD) ?? []
				const challenge = published[1] ?? ""

				// The record is taken down after verification: the domain still reads verified.
				world.dns.delete(RECORD)
				assert.strictEqual((yield* sso.verifyDomain(ORG, "acme.com")).domains[0]?.status, "verified")
				const refused = yield* sso
					.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					.pipe(Effect.flip)
				if (refused._tag !== "@maple/http/enterprise-sso/EnterpriseSsoDomainProofError") {
					return assert.fail(`expected a domain proof refusal, got ${refused._tag}`)
				}
				// It names the domain and the record to publish, as fields and in its sentence.
				assert.strictEqual(refused.domain, "acme.com")
				assert.strictEqual(refused.recordName, RECORD)
				assert.strictEqual(refused.recordValue, challenge)
				assert.isTrue(Str.includes(refused.recordValue)(refused.message))
				assert.strictEqual(world.clerk.connections.size, 0)

				world.dns.set(RECORD, published)
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))

				// Gone again by the time SSO is required.
				world.dns.delete(RECORD)
				const unproven = yield* sso.setEnforcement(ORG, true).pipe(Effect.flip)
				assert.strictEqual(unproven._tag, "@maple/http/enterprise-sso/EnterpriseSsoDomainProofError")

				// An unanswered lookup is not a proof either.
				world.dns.set(RECORD, published)
				dnsOutage.current = true
				const unanswered = yield* sso.setEnforcement(ORG, true).pipe(Effect.flip)
				assert.strictEqual(
					unanswered._tag,
					"@maple/http/enterprise-sso/EnterpriseSsoUnavailableError",
				)
				assert.match(unanswered.message, /Try again/)
				dnsOutage.current = false
				assert.strictEqual((yield* sso.get(ORG)).connection?.enforced, false)

				assert.strictEqual((yield* sso.setEnforcement(ORG, true)).connection?.enforced, true)
				// Turning it off never waits on DNS.
				dnsOutage.current = true
				assert.strictEqual((yield* sso.setEnforcement(ORG, false)).connection?.enforced, false)
			}),
		)
	})

	it.effect(
		"checks the TXT record of a domain an edit adds to the connection, not of the ones it keeps",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* verifiedDomain(world.dns, "acme.com")
					yield* verifiedDomain(world.dns, "acme.io")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					world.dns.delete("_maple-challenge.acme.com")
					world.dns.delete("_maple-challenge.acme.io")

					const added = yield* sso
						.updateConnection(ORG, samlRequest(["acme.com", "acme.io"]))
						.pipe(Effect.flip)
					assert.strictEqual(added._tag, "@maple/http/enterprise-sso/EnterpriseSsoDomainProofError")
					assert.isTrue(Str.includes("_maple-challenge.acme.io")(added.message))
					assert.deepStrictEqual((yield* sso.get(ORG)).connection?.domains, ["acme.com"])

					const renamed = yield* sso.updateConnection(
						ORG,
						new SsoConnectionRequest({ ...samlRequest(["acme.com"]), name: "Acme SSO" }),
					)
					assert.strictEqual(renamed.connection?.name, "Acme SSO")
				}),
			)
		},
	)

	it.effect(
		"keeps token rotation and certificate replacement open after the add-on ends, and nothing else",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			const manual = (overrides: { name?: string; ssoUrl?: string; certificate?: string }) =>
				new SsoConnectionRequest({
					name: overrides.name ?? "Acme IdP",
					provider: "saml_custom",
					domains: ["acme.com"],
					saml: new SsoSamlSettings({
						ssoUrl: overrides.ssoUrl ?? "https://idp.acme.com/sso",
						entityId: "https://idp.acme.com",
						...(overrides.certificate === undefined
							? undefined
							: { certificate: overrides.certificate }),
					}),
				})
			return Effect.gen(function* () {
				const first = yield* run(
					testDb,
					world,
					Effect.gen(function* () {
						const sso = yield* EnterpriseSsoService
						yield* verifiedDomain(world.dns, "acme.com")
						yield* sso.createConnection(ORG, ADMIN, manual({ certificate: "old certificate" }))
						return yield* sso.createDirectory(ORG)
					}),
				)
				world.entitled = false
				yield* run(
					testDb,
					world,
					Effect.gen(function* () {
						const sso = yield* EnterpriseSsoService
						assert.isFalse((yield* sso.get(ORG)).ssoEntitled)

						const rotated = yield* sso.rotateDirectoryToken(ORG)
						assert.match(rotated.token, /^scim_/)
						assert.notStrictEqual(rotated.token, first.token)

						yield* sso.updateConnection(ORG, manual({ certificate: "new certificate" }))
						assert.strictEqual(world.clerk.updates.at(-1)?.certificate, "new certificate")
						// The same goes for pointing it at the IdP's metadata again.
						yield* sso.updateConnection(
							ORG,
							new SsoConnectionRequest({
								name: "Acme IdP",
								provider: "saml_custom",
								domains: ["acme.com"],
								saml: { metadataUrl: "https://idp.acme.com/metadata" },
							}),
						)
						assert.strictEqual(
							world.clerk.updates.at(-1)?.metadataUrl,
							"https://idp.acme.com/metadata",
						)

						const updates = world.clerk.updates.length
						const refused = yield* Effect.all([
							Effect.flip(
								sso.updateConnection(ORG, manual({ name: "Renamed", certificate: "x" })),
							),
							Effect.flip(
								sso.updateConnection(
									ORG,
									manual({ ssoUrl: "https://elsewhere.example/sso", certificate: "x" }),
								),
							),
							Effect.flip(sso.addBypassUser(ORG, BREAK_GLASS)),
							Effect.flip(sso.createDirectory(ORG)),
						])
						assert.deepStrictEqual(Arr.dedupe(Arr.map(refused, (error) => error._tag)), [
							"@maple/http/enterprise-sso/EnterpriseSsoNotEntitledError",
						])
						assert.strictEqual(world.clerk.updates.length, updates)
						assert.deepStrictEqual(world.clerk.bypass, [])
					}),
				)
			})
		},
	)

	it.effect("lets an OIDC client secret be replaced after the add-on ends, but not the client", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		const oidc = (clientId: string, clientSecret: string) =>
			new SsoConnectionRequest({
				name: "Acme OIDC",
				provider: "oidc_custom",
				domains: ["acme.com"],
				oidc: {
					discoveryUrl: "https://id.acme.com/.well-known/openid-configuration",
					clientId,
					clientSecret,
				},
			})
		return Effect.gen(function* () {
			yield* run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.createConnection(ORG, ADMIN, oidc("maple", "old secret"))
				}),
			)
			world.entitled = false
			yield* run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					yield* sso.updateConnection(ORG, oidc("maple", "new secret"))
					assert.strictEqual(world.clerk.updates.at(-1)?.clientSecret, "new secret")
					const refused = yield* sso
						.updateConnection(ORG, oidc("another-client", "new secret"))
						.pipe(Effect.flip)
					assert.strictEqual(
						refused._tag,
						"@maple/http/enterprise-sso/EnterpriseSsoNotEntitledError",
					)
					assert.strictEqual(world.clerk.updates.length, 1)
				}),
			)
		})
	})

	it.effect(
		"summarises the state for a reader who cannot manage SSO, without settings, groups or people",
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
					yield* sso.setEnforcement(ORG, true)
					yield* sso.addBypassUser(ORG, BREAK_GLASS)
					yield* sso.createDirectory(ORG)
					const directoryId = [...world.clerk.directories.keys()][0] ?? ""
					yield* sso.applyDirectoryGroup({
						directoryId,
						groupId: "grp_admins",
						displayName: "Maple Admins",
						updatedAt: 1,
						deleted: false,
					})
					yield* sso.setRoleMappings(ORG, [{ groupId: "grp_admins", role: "org:admin" }])

					world.clerk.bypassLookups = 0
					const summary = yield* sso.getSummary(ORG)
					assert.deepStrictEqual(
						Arr.map(summary.domains, (d) => [d.domain, d.status]),
						[["acme.com", "verified"]],
					)
					assert.strictEqual(summary.connection?.enforced, true)
					assert.deepStrictEqual(summary.connection?.domains, ["acme.com"])
					assert.isFalse(summary.directory?.paused ?? true)
					assert.deepStrictEqual(summary.roleMappings, [])
					assert.deepStrictEqual(summary.groups, [])
					assert.deepStrictEqual(summary.bypassUsers, [])
					// Nothing that names the IdP's endpoints, the SCIM endpoint, a group or a person.
					const sent = JSON.stringify(summary)
					for (const secretish of ["clerk.test", "okta.com", "user_breakglass", "Maple Admins"]) {
						assert.isFalse(Str.includes(secretish)(sent), secretish)
					}
					assert.strictEqual(world.clerk.bypassLookups, 0)

					// The admin read is unchanged.
					const full = yield* sso.get(ORG)
					assert.match(full.directory?.endpointUrl ?? "", /^https:\/\/scim\.clerk\.test\//)
					assert.match(full.connection?.acsUrl ?? "", /^https:\/\/clerk\.test\//)
					assert.strictEqual(full.bypassUsers.length, 1)
					assert.strictEqual(full.groups.length, 1)
				}),
			)
		},
	)

	it.effect(
		"takes a former member off the bypass list, unless they rejoined or another organization needs the entry",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
			const DUAL = Schema.decodeSync(UserId)("user_dual")
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const sso = yield* EnterpriseSsoService
					// An organization without a connection has no list.
					assert.strictEqual(yield* sso.removeFormerMemberBypass(ORG, BREAK_GLASS), "not_listed")

					yield* verifiedDomain(world.dns, "acme.com")
					yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
					yield* sso.addBypassUser(ORG, BREAK_GLASS)
					assert.strictEqual(yield* sso.removeFormerMemberBypass(ORG, ADMIN), "not_listed")

					// A late delivery for someone who has rejoined since.
					assert.strictEqual(yield* sso.removeFormerMemberBypass(ORG, BREAK_GLASS), "kept")
					assert.deepStrictEqual(world.clerk.bypass, [BREAK_GLASS])

					world.clerk.members.delete(BREAK_GLASS)
					assert.strictEqual(yield* sso.removeFormerMemberBypass(ORG, BREAK_GLASS), "removed")
					assert.deepStrictEqual(world.clerk.bypass, [])

					// Another organization's connection serves this person's second address.
					world.clerk.bypass.push(DUAL)
					world.clerk.members.delete(DUAL)
					world.clerk.connections.set("ent_partner", {
						id: "ent_partner",
						name: "Partner IdP",
						provider: "saml_custom",
						domains: ["partner.io"],
						organizationId: OTHER_ORG,
						active: true,
						createdAt: 1,
						saml: null,
						oidc: null,
					})
					assert.strictEqual(yield* sso.removeFormerMemberBypass(ORG, DUAL), "kept")
					assert.deepStrictEqual(world.clerk.bypass, [DUAL])
				}),
			)
		},
	)

	it.effect("removes the Clerk connection and directory of an organization that is being deleted", () => {
		const testDb = createTestDb(trackedDbs)
		const world = { clerk: fakeClerk(), dns: new Map<string, Array<string>>(), entitled: true }
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const sso = yield* EnterpriseSsoService
				// Nothing configured is not a failure.
				yield* sso.removeForDeletedOrganization(OTHER_ORG)

				yield* verifiedDomain(world.dns, "acme.com")
				yield* sso.createConnection(ORG, ADMIN, samlRequest(["acme.com"]))
				yield* sso.createDirectory(ORG)

				// Clerk is down: the failure is raised and the row stays, so a retry finds it.
				world.clerk.failDeletes = true
				const failed = yield* sso.removeForDeletedOrganization(ORG).pipe(Effect.flip)
				assert.strictEqual(failed._tag, "@maple/http/enterprise-sso/EnterpriseSsoUnavailableError")
				assert.isNotNull((yield* sso.get(ORG)).connection)

				world.clerk.failDeletes = false
				yield* sso.removeForDeletedOrganization(ORG)
				assert.strictEqual(world.clerk.connections.size, 0)
				assert.strictEqual(world.clerk.directories.size, 0)
				assert.isNull((yield* sso.get(ORG)).connection)
				// A second attempt finds nothing left and succeeds.
				yield* sso.removeForDeletedOrganization(ORG)
			}),
		)
	})
})
