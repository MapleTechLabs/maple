import { AlertValidationError } from "@maple/domain/http"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { createHash } from "node:crypto"
import { EdgeCacheService, type EdgeCacheServiceApi } from "@maple/cache"
import { OrgId, RoleName, UserId } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { ConfigProvider, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { parseSecretKeyring, sealSecret } from "@maple/backend/platform/SecretBox"
import { alertDestinationSecretSlot } from "@maple/backend/platform/secret-slots"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { AuditLogService, type AuditLogRecordInput } from "@maple/backend/services/audit/AuditLogService"
import { CliDeviceAuthService } from "./CliDeviceAuthService"
import { McpOAuthService } from "./McpOAuthService"
import { MembershipRevocationService } from "./MembershipRevocationService"
import { pinAuthority } from "./pinned-authority"
import { ORG_MEMBERSHIP_CACHE_BUCKET } from "./OrgMembershipService"

const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

const ENCRYPTION_KEY = Buffer.alloc(32, 3)

const config = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_APP_BASE_URL: "https://app.example.com",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: ENCRYPTION_KEY.toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

/** Records what was evicted; nothing here needs a real edge cache. */
const recordingEdgeCache = () => {
	const invalidated: Array<{ bucket: string; key: string }> = []
	const api: EdgeCacheServiceApi = {
		getOrCompute: (_options, compute) =>
			compute.pipe(Effect.map((value) => ({ value, status: "miss", readMs: 0, wrote: false }))),
		invalidate: (options) =>
			Effect.sync(() => void invalidated.push({ bucket: options.bucket, key: options.key })),
		rawGetDetailed: () => Effect.succeed({ status: "miss", value: Option.none(), readMs: 0 }),
		rawGet: () => Effect.succeedNone,
		rawPut: () => Effect.void,
		rawDelete: () => Effect.void,
	}
	const layer = Layer.succeed(EdgeCacheService, api)
	return { invalidated, layer }
}

const recordingAudit = () => {
	const recorded: Array<AuditLogRecordInput> = []
	const layer = Layer.succeed(AuditLogService, {
		record: (input) => Effect.sync(() => void recorded.push(input)),
		list: () => Effect.succeed([]),
	})
	return { recorded, layer }
}

const makeLayer = (
	testDb: TestDb,
	edgeCache: Layer.Layer<EdgeCacheService>,
	audit: Layer.Layer<AuditLogService> = recordingAudit().layer,
) => {
	const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config())))
	const apiKeys = ApiKeysService.layer.pipe(Layer.provide(base))
	return Layer.mergeAll(
		MembershipRevocationService.layer.pipe(Layer.provide(Layer.mergeAll(base, edgeCache, audit))),
		McpOAuthService.layer.pipe(Layer.provide(base)),
		CliDeviceAuthService.layer.pipe(Layer.provideMerge(apiKeys), Layer.provide(base)),
		apiKeys,
		base,
	)
}

const orgId = Schema.decodeSync(OrgId)("org_revoke")
const otherOrgId = Schema.decodeSync(OrgId)("org_other")
const userId = Schema.decodeSync(UserId)("user_leaver")
const stayerId = Schema.decodeSync(UserId)("user_stayer")
const memberRole = Schema.decodeSync(RoleName)("org:member")
const adminRole = Schema.decodeSync(RoleName)("org:admin")
const engineerRole = Schema.decodeSync(RoleName)("org:engineer")
const resource = "https://api.example.com/mcp"
const redirectUri = "http://127.0.0.1:49152/callback"
const verifier = "maple-mcp-oauth-verifier-that-is-long-enough-1234567890"
const challenge = createHash("sha256").update(verifier).digest("base64url")

const seedEmailDestination = (db: TestDb, id: string, org: OrgId, members: Array<UserId>) =>
	Effect.gen(function* () {
		const secret = JSON.stringify({
			type: "email",
			members: Arr.map(members, (member) => ({
				userId: member,
				email: `${member}@example.com`,
				name: null,
			})),
		})
		const onError = (message: string) => new AlertValidationError({ message, details: [] })
		const keyring = yield* parseSecretKeyring(
			{ primary: ENCRYPTION_KEY.toString("base64"), decryptOnly: Option.none() },
			onError,
		)
		const encrypted = yield* sealSecret(
			keyring,
			alertDestinationSecretSlot,
			{ orgId: org, id },
			secret,
			onError,
		)
		yield* Effect.promise(() =>
			db.pglite.query(
				`insert into alert_destinations
					(id, org_id, name, type, config_json, secret_ciphertext, secret_iv, secret_tag,
					 created_at, updated_at, created_by, updated_by)
				 values ($1, $2, 'Oncall email', 'email', $3, $4, $5, $6, now(), now(), 'seed', 'seed')`,
				[
					id,
					org,
					JSON.stringify({
						summary: "Oncall",
						channelLabel: null,
						memberUserIds: members,
					}),
					encrypted.ciphertext,
					encrypted.iv,
					encrypted.tag,
				],
			),
		)
	})

const seedMobileDevice = (db: TestDb, id: string, org: OrgId, user: UserId) =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into mobile_devices
				(id, org_id, user_id, platform, token, environment, bundle_id, preferences,
				 last_seen_at, created_at, updated_at)
			 values ($1, $2, $3, 'ios', $1, 'production', 'dev.maple.app', '{}'::jsonb, now(), now(), now())`,
			[id, org, user],
		),
	)

/** A Live Activity running on `deviceId` for one incident. */
const seedLiveActivity = (db: TestDb, id: string, org: OrgId, deviceId: string) =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into live_activities
				(id, org_id, device_id, incident_id, activity_id, push_token, created_at, updated_at)
			 values ($1, $2, $3, 'inc_1', $1, $1, now(), now())`,
			[id, org, deviceId],
		),
	)

/** One linked chat account, which is standing authority to approve changes as that user. */
const seedChatIdentity = (db: TestDb, id: string, org: OrgId, user: UserId) =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into chat_identities (id, org_id, connector, external_user_id, user_id, created_at)
			 values ($1, $2, 'testchat', $1, $3, now())`,
			[id, org, user],
		),
	)

/** An MCP authorization the user approved and the client has not exchanged yet. */
const approveMcpAuthorization = Effect.fnUntraced(function* (
	oauth: McpOAuthService,
	user: UserId,
	org: OrgId,
	roles: ReadonlyArray<RoleName> = [memberRole],
) {
	const client = yield* oauth.register(
		{ clientName: `Client ${user}`, redirectUris: [redirectUri] },
		"127.0.0.1",
	)
	const started = yield* oauth.startAuthorization(
		{
			clientId: client.client_id,
			redirectUri,
			responseType: "code",
			codeChallenge: challenge,
			codeChallengeMethod: "S256",
			resource,
			expectedResource: resource,
		},
		"127.0.0.1",
	)
	const requestId = new URL(started.consentUrl).searchParams.get("request_id")!
	const approved = yield* oauth.approve(requestId, {
		orgId: org,
		userId: user,
		roles,
		userEmail: null,
	})
	return { clientId: client.client_id, code: new URL(approved.redirectUri).searchParams.get("code")! }
})

const exchangeMcpCode = (oauth: McpOAuthService, approval: { clientId: string; code: string }) =>
	oauth.exchangeAuthorizationCode(
		{
			code: approval.code,
			clientId: approval.clientId,
			redirectUri,
			codeVerifier: verifier,
			resource,
		},
		"127.0.0.1",
	)

const issueMcpGrant = Effect.fnUntraced(function* (
	oauth: McpOAuthService,
	user: UserId,
	org: OrgId,
	roles: ReadonlyArray<RoleName> = [memberRole],
) {
	const approval = yield* approveMcpAuthorization(oauth, user, org, roles)
	const tokens = yield* exchangeMcpCode(oauth, approval)
	return { clientId: approval.clientId, tokens }
})

/** A digest subscriber row; `optedOut` stamps the member's own opt-out. */
const seedDigestSubscription = (db: TestDb, id: string, org: OrgId, user: UserId, optedOut = false) =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into digest_subscriptions
				(id, org_id, user_id, email, enabled, opted_out_at, created_at, updated_at)
			 values ($1, $2, $3, $1 || '@example.com', $4, CASE WHEN $5 THEN now() END, now(), now())`,
			[id, org, user, !optedOut, optedOut],
		),
	)

const digestState = (db: TestDb) =>
	Effect.promise(() =>
		db.pglite.query<{ id: string; enabled: boolean; web_analytics_enabled: boolean; opted_out: boolean }>(
			`select id, enabled, web_analytics_enabled, opted_out_at is not null as opted_out
			 from digest_subscriptions order by id`,
		),
	).pipe(Effect.map((result) => result.rows))

/** A dashboard plus one live share link on it, made by `creator`. */
const seedShare = (db: TestDb, id: string, org: OrgId, creator: UserId) =>
	Effect.promise(async () => {
		await db.pglite.query(
			`insert into dashboards (org_id, id, name, payload_json, created_at, updated_at, created_by, updated_by)
			 values ($1, $2, 'Ops', '{}'::jsonb, now(), now(), $3, $3)`,
			[org, `dash_${id}`, creator],
		)
		await db.pglite.query(
			`insert into dashboard_shares
				(org_id, id, dashboard_id, mode, token_hash, token_ciphertext, token_iv, token_tag,
				 token_suffix, created_at, created_by, updated_at, updated_by)
			 values ($1, $2, $3, 'public', $2, 'c', 'i', 't', 'sfx', now(), $4, now(), $4)`,
			[org, id, `dash_${id}`, creator],
		)
	})

/** A non-email destination; the secret is never read on this path, so any bytes do. */
const seedWebhookDestination = (db: TestDb, id: string, org: OrgId, creator: UserId, type = "webhook") =>
	Effect.promise(() =>
		db.pglite.query(
			`insert into alert_destinations
				(id, org_id, name, type, config_json, secret_ciphertext, secret_iv, secret_tag,
				 created_at, updated_at, created_by, updated_by)
			 values ($1, $2, $3 || $1, $3, '{}'::jsonb, 'c', 'i', 't', now(), now(), $4, $4)`,
			[id, org, type, creator],
		),
	)

const countRows = (db: TestDb, sql: string, params: unknown[] = []) =>
	Effect.promise(() => queryFirstRow<{ count: number }>(db, sql, params)).pipe(
		Effect.map((row) => Number(row?.count ?? 0)),
	)

describe("MembershipRevocationService", () => {
	it.effect("retires every credential a removed member held in that org", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const cli = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService

			const grant = yield* issueMcpGrant(oauth, userId, orgId)
			const started = yield* cli.start("Leaver laptop", "127.0.0.1")
			yield* cli.approve(started.userCode, {
				orgId,
				userId,
				roles: [memberRole],
				userEmail: null,
			})
			const cliToken = yield* cli.poll(started.deviceCode)
			yield* seedMobileDevice(db, "dev_leaver", orgId, userId)
			yield* seedEmailDestination(db, "00000000-0000-4000-8000-0000000000d1", orgId, [userId, stayerId])
			yield* seedChatIdentity(db, "00000000-0000-4000-8000-0000000000c1", orgId, userId)

			expect(Option.isSome(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)

			const summary = yield* revocation.revokeMembership(orgId, userId)

			// The cache is the widest window and is evicted first.
			expect(cache.invalidated).toEqual([{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId }])
			expect(summary.mcpFamiliesRevoked).toBe(1)
			expect(summary.cliAuthorizationsDeleted).toBe(1)
			expect(summary.mobileDevicesDeleted).toBe(1)
			expect(summary.emailDestinationsUpdated).toBe(1)
			// A linked chat account can approve changes AS this user; leaving the org ends that.
			expect(summary.chatIdentitiesDeleted).toBe(1)

			// Both credentials are dead, and the MCP grant cannot be refreshed back.
			expect(Option.isNone(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)
			if (cliToken.status === "complete") {
				expect(Option.isNone(yield* apiKeys.resolveByKey(cliToken.token))).toBe(true)
			}
			const refreshFailure = yield* oauth
				.refresh(
					{ refreshToken: grant.tokens.refresh_token, clientId: grant.clientId, resource },
					"127.0.0.1",
				)
				.pipe(Effect.flip)
			expect(refreshFailure._tag).toBe("@maple/backend/errors/McpOAuthProtocolError")

			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(0)
			expect(yield* countRows(db, "select count(*)::int as count from cli_device_authorizations")).toBe(
				0,
			)
			expect(
				yield* countRows(
					db,
					"select count(*)::int as count from mcp_oauth_refresh_tokens where revoked_at is null",
				),
			).toBe(0)

			// The remaining member keeps the destination; the leaver is gone from
			// both the public config and the encrypted recipient snapshot.
			const destination = yield* Effect.promise(() =>
				queryFirstRow<{ config_json: { memberUserIds: string[] }; enabled: boolean }>(
					db,
					"select config_json, enabled from alert_destinations where id = '00000000-0000-4000-8000-0000000000d1'",
				),
			)
			expect(destination?.config_json.memberUserIds).toEqual([stayerId])
			expect(destination?.enabled).toBe(true)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("leaves other organizations and other members untouched", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService

			const elsewhere = yield* issueMcpGrant(oauth, userId, otherOrgId)
			yield* seedMobileDevice(db, "dev_other_org", otherOrgId, userId)
			yield* seedMobileDevice(db, "dev_other_user", orgId, stayerId)

			yield* revocation.revokeMembership(orgId, userId)

			expect(Option.isSome(yield* apiKeys.resolveByKey(elsewhere.tokens.access_token))).toBe(true)
			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(2)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("disables an email destination whose last recipient left", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedEmailDestination(db, "00000000-0000-4000-8000-0000000000d2", orgId, [userId])

			yield* revocation.revokeMembership(orgId, userId)

			const destination = yield* Effect.promise(() =>
				queryFirstRow<{
					enabled: boolean
					disabled_reason: string | null
					config_json: { memberUserIds: string[] }
				}>(db, "select enabled, disabled_reason, config_json from alert_destinations"),
			)
			expect(destination?.config_json.memberUserIds).toEqual([])
			// Disabled rather than deleted: the rules pointing at it stay valid and
			// an admin can see why it went quiet.
			expect(destination?.enabled).toBe(false)
			expect(destination?.disabled_reason).toContain("left the organization")
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("stops a removed member's digests in that org only", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedDigestSubscription(db, "dig_leaver", orgId, userId)
			yield* seedDigestSubscription(db, "dig_leaver_other_org", otherOrgId, userId)
			yield* seedDigestSubscription(db, "dig_stayer", orgId, stayerId)

			const summary = yield* revocation.revokeMembership(orgId, userId)

			expect(summary.digestSubscriptionsDisabled).toBe(1)
			expect(yield* digestState(db)).toEqual([
				{ id: "dig_leaver", enabled: false, web_analytics_enabled: false, opted_out: false },
				{ id: "dig_leaver_other_org", enabled: true, web_analytics_enabled: true, opted_out: false },
				{ id: "dig_stayer", enabled: true, web_analytics_enabled: true, opted_out: false },
			])
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("stops a deleted user's digests in every org and keeps their own opt-out", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedDigestSubscription(db, "dig_a", orgId, userId)
			yield* seedDigestSubscription(db, "dig_b", otherOrgId, userId, true)
			yield* seedDigestSubscription(db, "dig_c", orgId, stayerId)

			const summary = yield* revocation.revokeUser(userId)

			expect(summary.digestSubscriptionsDisabled).toBe(2)
			expect(yield* digestState(db)).toEqual([
				{ id: "dig_a", enabled: false, web_analytics_enabled: false, opted_out: false },
				{ id: "dig_b", enabled: false, web_analytics_enabled: false, opted_out: true },
				{ id: "dig_c", enabled: true, web_analytics_enabled: true, opted_out: false },
			])
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("is idempotent, so a webhook retry converges instead of double-applying", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			yield* issueMcpGrant(oauth, userId, orgId)
			yield* seedMobileDevice(db, "dev_retry", orgId, userId)
			yield* seedEmailDestination(db, "00000000-0000-4000-8000-0000000000d3", orgId, [userId, stayerId])

			const first = yield* revocation.revokeMembership(orgId, userId)
			const second = yield* revocation.revokeMembership(orgId, userId)

			expect(first.mobileDevicesDeleted).toBe(1)
			expect(first.emailDestinationsUpdated).toBe(1)
			expect(second.mobileDevicesDeleted).toBe(0)
			expect(second.apiKeysRevoked).toBe(0)
			// The second pass finds the member already absent and rewrites nothing.
			expect(second.emailDestinationsUpdated).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("retires the admin-pinned keys of a demoted member and spares everyone else's", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const cli = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService

			// `maple auth login` as an admin: the CLI key freezes `org:admin` into
			// its metadata and `resolveByKey` never re-checks the membership.
			const asAdmin = yield* cli.start("Admin laptop", "127.0.0.1")
			yield* cli.approve(asAdmin.userCode, {
				orgId,
				userId,
				roles: [adminRole],
				userEmail: null,
			})
			const adminToken = yield* cli.poll(asAdmin.deviceCode)
			// A second member who was never an admin, and the same user in another org.
			const asMember = yield* cli.start("Member laptop", "127.0.0.1")
			yield* cli.approve(asMember.userCode, {
				orgId,
				userId: stayerId,
				roles: [memberRole],
				userEmail: null,
			})
			const memberToken = yield* cli.poll(asMember.deviceCode)
			const elsewhere = yield* cli.start("Other org laptop", "127.0.0.1")
			yield* cli.approve(elsewhere.userCode, {
				orgId: otherOrgId,
				userId,
				roles: [adminRole],
				userEmail: null,
			})
			const elsewhereToken = yield* cli.poll(elsewhere.deviceCode)

			// A promotion strips nothing.
			const promoted = yield* revocation.demoteMembership(orgId, userId, Policy.grantsOf([adminRole]))
			expect(promoted.apiKeysRevoked).toBe(0)

			const demoted = yield* revocation.demoteMembership(orgId, userId, Policy.grantsOf([memberRole]))
			expect(demoted.apiKeysRevoked).toBe(1)
			expect(cache.invalidated).toEqual([
				{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId },
				{ bucket: ORG_MEMBERSHIP_CACHE_BUCKET, key: userId },
			])

			if (adminToken.status === "complete") {
				expect(Option.isNone(yield* apiKeys.resolveByKey(adminToken.token))).toBe(true)
			}
			if (memberToken.status === "complete") {
				expect(Option.isSome(yield* apiKeys.resolveByKey(memberToken.token))).toBe(true)
			}
			if (elsewhereToken.status === "complete") {
				expect(Option.isSome(yield* apiKeys.resolveByKey(elsewhereToken.token))).toBe(true)
			}

			// Idempotent, so a Clerk retry converges.
			const retry = yield* revocation.demoteMembership(orgId, userId, Policy.grantsOf([memberRole]))
			expect(retry.apiKeysRevoked).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("retires whatever was pinned above the new role, engineer keys included", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const cli = yield* CliDeviceAuthService
			const apiKeys = yield* ApiKeysService
			const login = (user: typeof userId, role: typeof adminRole) =>
				Effect.gen(function* () {
					const started = yield* cli.start("Laptop", "127.0.0.1")
					yield* cli.approve(started.userCode, {
						orgId,
						userId: user,
						roles: [role],
						userEmail: null,
					})
					return yield* cli.poll(started.deviceCode)
				})
			const stillWorks = (token: Effect.Success<ReturnType<typeof login>>) =>
				token.status === "complete"
					? Effect.map(apiKeys.resolveByKey(token.token), Option.isSome)
					: Effect.succeed(false)

			// An admin demoted to engineer loses the admin key.
			const adminToken = yield* login(userId, adminRole)
			const toEngineer = yield* revocation.demoteMembership(
				orgId,
				userId,
				Policy.grantsOf([engineerRole]),
			)
			expect(toEngineer.apiKeysRevoked).toBe(1)
			expect(yield* stillWorks(adminToken)).toBe(false)

			// An engineer keeps an engineer key while still an engineer, and loses it as a member.
			const engineerToken = yield* login(stayerId, engineerRole)
			const unchanged = yield* revocation.demoteMembership(
				orgId,
				stayerId,
				Policy.grantsOf([engineerRole]),
			)
			expect(unchanged.apiKeysRevoked).toBe(0)
			expect(yield* stillWorks(engineerToken)).toBe(true)
			const toMember = yield* revocation.demoteMembership(
				orgId,
				stayerId,
				Policy.grantsOf([memberRole]),
			)
			expect(toMember.apiKeysRevoked).toBe(1)
			expect(yield* stillWorks(engineerToken)).toBe(false)

			// An approval made as an engineer and not yet redeemed mints nothing after the demotion.
			const pending = yield* cli.start("Laptop", "127.0.0.1")
			yield* cli.approve(pending.userCode, {
				orgId,
				userId: stayerId,
				roles: [engineerRole],
				userEmail: null,
			})
			// One approved at the role the member keeps survives.
			const kept = yield* cli.start("Laptop", "127.0.0.1")
			yield* cli.approve(kept.userCode, {
				orgId,
				userId: stayerId,
				roles: [memberRole],
				userEmail: null,
			})
			yield* revocation.demoteMembership(orgId, stayerId, Policy.grantsOf([memberRole]))
			expect((yield* cli.poll(pending.deviceCode)).status).toBe("expired")
			expect((yield* cli.poll(kept.deviceCode)).status).toBe("complete")
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect(
		"retires a custom-role key when the new grants are narrower, and keeps it when they cover it",
		() => {
			const db = createTestDb(createdDbs)
			const cache = recordingEdgeCache()
			return Effect.gen(function* () {
				const revocation = yield* MembershipRevocationService
				const cli = yield* CliDeviceAuthService
				const apiKeys = yield* ApiKeysService
				const customRole = Schema.decodeSync(RoleName)(Policy.CUSTOM_ROLE_CLERK_KEY)

				const started = yield* cli.start("Custom laptop", "127.0.0.1")
				yield* cli.approve(started.userCode, {
					orgId,
					userId: stayerId,
					roles: [customRole],
					permissions: ["telemetry:read", "alerts:manage"],
					userEmail: null,
				})
				const token = yield* cli.poll(started.deviceCode)
				expect(token.status).toBe("complete")
				const resolve = () =>
					token.status === "complete" ? apiKeys.resolveByKey(token.token) : Effect.succeedNone

				const widened = yield* revocation.demoteMembership(
					orgId,
					stayerId,
					Policy.grantsOf([customRole], ["telemetry:read", "alerts:manage", "slos:manage"]),
				)
				expect(widened.apiKeysRevoked).toBe(0)
				const kept = yield* resolve()
				expect(Option.map(kept, (key) => [...key.permissions].sort())).toEqual(
					Option.some(["alerts:manage", "telemetry:read"]),
				)

				const narrowed = yield* revocation.demoteMembership(
					orgId,
					stayerId,
					Policy.grantsOf([customRole], ["telemetry:read"]),
				)
				expect(narrowed.apiKeysRevoked).toBe(1)
				expect(Option.isNone(yield* resolve())).toBe(true)
			}).pipe(Effect.provide(makeLayer(db, cache.layer)))
		},
	)

	it.effect("narrows a restricted key whose scopes still fit the new role instead of retiring it", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const apiKeys = yield* ApiKeysService
			const customRole = Schema.decodeSync(RoleName)(Policy.CUSTOM_ROLE_CLERK_KEY)
			const minted = (name: string, scopes: ReadonlyArray<string>) =>
				apiKeys.create(orgId, stayerId, {
					name,
					scopes,
					metadataJson: {
						source: "maple_api_key",
						...pinAuthority({
							roles: [customRole],
							permissions: Policy.grantsOf([customRole], ["alerts:manage", "dashboards:edit"]),
						}),
					},
				})
			const dashboards = yield* minted("dashboards", ["dashboards:write"])
			const alerts = yield* minted("alerts", ["alerts:write"])

			const demoted = yield* revocation.demoteMembership(
				orgId,
				stayerId,
				Policy.grantsOf([customRole], ["dashboards:edit"]),
			)

			expect(demoted.apiKeysRevoked).toBe(1)
			expect(Option.isNone(yield* apiKeys.resolveByKey(alerts.secret))).toBe(true)
			const kept = yield* apiKeys.resolveByKey(dashboards.secret)
			expect(Option.map(kept, (key) => [...key.permissions].sort())).toEqual(
				Option.some(["dashboards:edit", "telemetry:read"]),
			)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("kills the refresh family behind a demoted member's MCP grant", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService
			const apiKeys = yield* ApiKeysService

			const grant = yield* issueMcpGrant(oauth, userId, orgId, [adminRole])
			const summary = yield* revocation.demoteMembership(orgId, userId, Policy.grantsOf([memberRole]))

			// The visible key alone would be re-minted by the next rotation.
			expect(summary.apiKeysRevoked).toBe(1)
			expect(summary.mcpFamiliesRevoked).toBe(1)
			expect(Option.isNone(yield* apiKeys.resolveByKey(grant.tokens.access_token))).toBe(true)
			expect(
				yield* countRows(
					db,
					"select count(*)::int as count from mcp_oauth_refresh_tokens where revoked_at is null",
				),
			).toBe(0)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("leaves nothing to exchange from an MCP approval made above the new role", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			const oauth = yield* McpOAuthService

			const pending = yield* approveMcpAuthorization(oauth, stayerId, orgId, [engineerRole])
			const kept = yield* approveMcpAuthorization(oauth, stayerId, orgId, [memberRole])
			yield* revocation.demoteMembership(orgId, stayerId, Policy.grantsOf([memberRole]))

			const refused = yield* Effect.result(exchangeMcpCode(oauth, pending))
			expect(refused._tag).toBe("Failure")
			if (refused._tag === "Failure") expect(refused.failure).toMatchObject({ error: "invalid_grant" })
			// One approved at the role the member keeps is still good.
			expect((yield* exchangeMcpCode(oauth, kept)).token_type).toBe("Bearer")
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("sweeps every org for a deleted user", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedMobileDevice(db, "dev_a", orgId, userId)
			yield* seedMobileDevice(db, "dev_b", otherOrgId, userId)
			yield* seedMobileDevice(db, "dev_c", orgId, stayerId)

			const summary = yield* revocation.revokeUser(userId)

			expect(summary.mobileDevicesDeleted).toBe(2)
			expect(yield* countRows(db, "select count(*)::int as count from mobile_devices")).toBe(1)
		}).pipe(Effect.provide(makeLayer(db, cache.layer)))
	})

	it.effect("revokes the share links a removed member made in that org, keeping the rows", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		const audit = recordingAudit()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedShare(db, "dshare_leaver", orgId, userId)
			yield* seedShare(db, "dshare_leaver_elsewhere", otherOrgId, userId)
			yield* seedShare(db, "dshare_stayer", orgId, stayerId)

			const summary = yield* revocation.revokeMembership(orgId, userId)
			const retry = yield* revocation.revokeMembership(orgId, userId)

			expect(summary.dashboardSharesRevoked).toBe(1)
			expect(retry.dashboardSharesRevoked).toBe(0)
			const rows = yield* Effect.promise(() =>
				db.pglite.query<{ id: string; revoked: boolean }>(
					"select id, revoked_at is not null as revoked from dashboard_shares order by id",
				),
			)
			expect(rows.rows).toEqual([
				{ id: "dshare_leaver", revoked: true },
				{ id: "dshare_leaver_elsewhere", revoked: false },
				{ id: "dshare_stayer", revoked: false },
			])
			// One entry per link, and none for the retry that found nothing left.
			expect(
				Arr.map(audit.recorded, (entry) => [entry.action, entry.orgId, entry.affectedUserId]),
			).toEqual([["dashboard_share.revoked", orgId, userId]])
		}).pipe(Effect.provide(makeLayer(db, cache.layer, audit.layer)))
	})

	it.effect("disables the webhook and chat destinations a removed member created", () => {
		const db = createTestDb(createdDbs)
		const cache = recordingEdgeCache()
		const audit = recordingAudit()
		return Effect.gen(function* () {
			const revocation = yield* MembershipRevocationService
			yield* seedWebhookDestination(db, "00000000-0000-4000-8000-0000000000e5", orgId, userId)
			yield* seedWebhookDestination(db, "00000000-0000-4000-8000-0000000000e4", orgId, userId, "teams")
			yield* seedWebhookDestination(db, "00000000-0000-4000-8000-0000000000e2", otherOrgId, userId)
			yield* seedWebhookDestination(db, "00000000-0000-4000-8000-0000000000e3", orgId, stayerId)
			yield* seedEmailDestination(db, "00000000-0000-4000-8000-0000000000d4", orgId, [stayerId])
			yield* Effect.promise(() =>
				db.pglite.query("update alert_destinations set created_by = $1 where type = 'email'", [
					userId,
				]),
			)

			const summary = yield* revocation.revokeMembership(orgId, userId)

			expect(summary.alertDestinationsDisabled).toBe(2)
			const rows = yield* Effect.promise(() =>
				db.pglite.query<{ id: string; enabled: boolean; disabled_reason: string | null }>(
					"select id, enabled, disabled_reason from alert_destinations order by id",
				),
			)
			// The email destination is handled by recipient, so a stayer's inbox keeps its alerts.
			expect(rows.rows).toEqual([
				{ id: "00000000-0000-4000-8000-0000000000d4", enabled: true, disabled_reason: null },
				{ id: "00000000-0000-4000-8000-0000000000e2", enabled: true, disabled_reason: null },
				{ id: "00000000-0000-4000-8000-0000000000e3", enabled: true, disabled_reason: null },
				{
					id: "00000000-0000-4000-8000-0000000000e4",
					enabled: false,
					disabled_reason: "Creator left the organization",
				},
				{
					id: "00000000-0000-4000-8000-0000000000e5",
					enabled: false,
					disabled_reason: "Creator left the organization",
				},
			])
			expect(Arr.map(audit.recorded, (entry) => entry.action)).toEqual([
				"alert_destination.disabled",
				"alert_destination.disabled",
			])
		}).pipe(Effect.provide(makeLayer(db, cache.layer, audit.layer)))
	})

	it.effect(
		"takes a demoted member's phones and Live Activities when the new role reads no telemetry",
		() => {
			const db = createTestDb(createdDbs)
			const custom = Schema.decodeSync(RoleName)(Policy.CUSTOM_ROLE_CLERK_KEY)
			const devices = (sql: string) =>
				Effect.promise(() => db.pglite.query<{ id: string }>(sql)).pipe(
					Effect.map((result) => Arr.map(result.rows, (row) => row.id)),
				)
			return Effect.gen(function* () {
				const revocation = yield* MembershipRevocationService
				yield* seedMobileDevice(db, "dev_demoted", orgId, userId)
				yield* seedMobileDevice(db, "dev_demoted_other_org", otherOrgId, userId)
				yield* seedMobileDevice(db, "dev_stayer", orgId, stayerId)
				yield* seedLiveActivity(db, "act_demoted", orgId, "dev_demoted")
				yield* seedLiveActivity(db, "act_stayer", orgId, "dev_stayer")

				// Still reads telemetry: the phone keeps its pushes.
				yield* revocation.demoteMembership(
					orgId,
					userId,
					Policy.grantsOf([custom], ["telemetry:read"]),
				)
				expect(yield* devices("select id from mobile_devices order by id")).toEqual([
					"dev_demoted",
					"dev_demoted_other_org",
					"dev_stayer",
				])

				const summary = yield* revocation.demoteMembership(
					orgId,
					userId,
					Policy.grantsOf([custom], ["billing:manage"]),
				)
				expect(summary.mobileDevicesDeleted).toBe(1)
				expect(yield* devices("select id from mobile_devices order by id")).toEqual([
					"dev_demoted_other_org",
					"dev_stayer",
				])
				expect(yield* devices("select id from live_activities order by id")).toEqual(["act_stayer"])
			}).pipe(Effect.provide(makeLayer(db, recordingEdgeCache().layer)))
		},
	)

	describe("a demotion retires what the new role could not set up", () => {
		const custom = Schema.decodeSync(RoleName)(Policy.CUSTOM_ROLE_CLERK_KEY)
		const seedAll = (db: TestDb) =>
			Effect.gen(function* () {
				yield* seedShare(db, "dshare_demoted", orgId, userId)
				yield* seedShare(db, "dshare_stayer", orgId, stayerId)
				yield* seedDigestSubscription(db, "digest_demoted", orgId, userId)
				yield* seedWebhookDestination(db, "00000000-0000-4000-8000-0000000000f1", orgId, userId)
			})
		const state = (db: TestDb) =>
			Effect.gen(function* () {
				const shares = yield* Effect.promise(() =>
					db.pglite.query<{ id: string; revoked: boolean }>(
						"select id, revoked_at is not null as revoked from dashboard_shares order by id",
					),
				)
				const destinations = yield* Effect.promise(() =>
					db.pglite.query<{ enabled: boolean; disabled_reason: string | null }>(
						"select enabled, disabled_reason from alert_destinations",
					),
				)
				return {
					shares: shares.rows,
					digests: Arr.map(yield* digestState(db), (row) => row.enabled),
					destinations: destinations.rows,
				}
			})

		it.effect(
			"a role without telemetry or sharing loses links and digest, and the org keeps its destinations",
			() => {
				const db = createTestDb(createdDbs)
				const audit = recordingAudit()
				return Effect.gen(function* () {
					const revocation = yield* MembershipRevocationService
					yield* seedAll(db)

					const summary = yield* revocation.demoteMembership(
						orgId,
						userId,
						Policy.grantsOf([custom], ["billing:manage"]),
					)

					expect([summary.dashboardSharesRevoked, summary.digestSubscriptionsDisabled]).toEqual([
						1, 1,
					])
					expect(yield* state(db)).toEqual({
						shares: [
							{ id: "dshare_demoted", revoked: true },
							{ id: "dshare_stayer", revoked: false },
						],
						digests: [false],
						destinations: [{ enabled: true, disabled_reason: null }],
					})
					expect(Arr.map(audit.recorded, (entry) => [entry.action, entry.metadata])).toEqual([
						["dashboard_share.revoked", { reason: "role_changed" }],
					])
				}).pipe(Effect.provide(makeLayer(db, recordingEdgeCache().layer, audit.layer)))
			},
		)

		it.effect(
			"a role that still reads and shares keeps them; losing only sharing revokes the links",
			() => {
				const db = createTestDb(createdDbs)
				return Effect.gen(function* () {
					const revocation = yield* MembershipRevocationService
					yield* seedAll(db)

					yield* revocation.demoteMembership(orgId, userId, Policy.grantsOf([memberRole]))
					const asMember = yield* state(db)
					// A member reads and shares; the engineer's alert destinations keep routing.
					expect([asMember.shares, asMember.digests]).toEqual([
						[
							{ id: "dshare_demoted", revoked: false },
							{ id: "dshare_stayer", revoked: false },
						],
						[true],
					])
					expect(Arr.map(asMember.destinations, (row) => row.enabled)).toEqual([true])

					yield* revocation.demoteMembership(
						orgId,
						userId,
						Policy.grantsOf([custom], ["telemetry:read"]),
					)
					const asReader = yield* state(db)
					expect([asReader.shares, asReader.digests]).toEqual([
						[
							{ id: "dshare_demoted", revoked: true },
							{ id: "dshare_stayer", revoked: false },
						],
						[true],
					])
				}).pipe(Effect.provide(makeLayer(db, recordingEdgeCache().layer)))
			},
		)
	})
})
