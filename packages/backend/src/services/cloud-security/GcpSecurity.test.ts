import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Result, Schema, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { GcpProjectId, OrgId } from "@maple/primitives"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { GooglePushTokens, PushTokenRejected } from "../integrations/gcp/security-push"
import { CloudSecurityStore } from "./CloudSecurityStore"
import { GcpSecurityEventsService } from "./GcpSecurityEventsService"
import { GcpSecurityFindingsService, sccFeedDue } from "./GcpSecurityFindingsService"
import { readSccFinding, sccTitle } from "./scc-findings"

const NOW = Date.UTC(2026, 10, 28, 12, 0, 0)
const CONNECTOR = "0d3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80"
const ORG = Schema.decodeSync(OrgId)("org_gcp")
const PROJECT = Schema.decodeSync(GcpProjectId)("acme-prod")
const READER = "maple-0d3c6f1e6b8f4e6b9a1e2f4c@acme-prod.iam.gserviceaccount.com"
const GOOD_TOKEN = "good-token"
const OTHER_ACCOUNT_TOKEN = "other-account-token"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

let encodedKey = ""
beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	)
	const body = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64")
	const lines = Arr.join(
		Option.getOrElse(Str.match(/.{1,64}/g)(body), () => []),
		"\n",
	)
	encodedKey = Buffer.from(
		JSON.stringify({
			type: "service_account",
			private_key_id: "key-1",
			private_key: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
			client_email: "collector@maple-prod.iam.gserviceaccount.com",
		}),
	).toString("base64")
})

/** One SCC result as `findings.list` returns it, and as a notification carries it. */
const sccResult = (id: string, overrides: Record<string, unknown> = {}) => ({
	finding: {
		name: `projects/123456789012/sources/42/locations/global/findings/${id}`,
		category: "PUBLIC_BUCKET_ACL",
		description: "The bucket grants allUsers read access.",
		resourceName: "//storage.googleapis.com/acme-public-assets",
		state: "ACTIVE",
		severity: "HIGH",
		mute: "UNMUTED",
		findingClass: "MISCONFIGURATION",
		eventTime: "2026-11-28T11:00:00Z",
		createTime: "2026-11-20T09:00:00Z",
		...overrides,
	},
	resource: {
		name: "//storage.googleapis.com/acme-public-assets",
		displayName: "acme-public-assets",
		type: "google.cloud.storage.Bucket",
		gcpMetadata: {
			project: "//cloudresourcemanager.googleapis.com/projects/123456789012",
			projectDisplayName: "acme-prod",
		},
	},
})

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

interface Calls {
	readonly impersonated: Array<string>
	readonly listed: Array<{
		readonly path: string
		readonly filter: string | null
		readonly auth: string | null
	}>
}

const stubFetch =
	(calls: Calls, scc: () => Response) =>
	async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
		)
		if (url.host === "oauth2.googleapis.com")
			return json({ access_token: "maple-token", expires_in: 600 })
		if (url.host === "iamcredentials.googleapis.com") {
			calls.impersonated.push(decodeURIComponent(url.pathname))
			return json({ accessToken: "reader-token" })
		}
		if (url.host === "securitycenter.googleapis.com") {
			calls.listed.push({
				path: url.pathname,
				filter: url.searchParams.get("filter"),
				auth: new Headers(init?.headers).get("authorization"),
			})
			return scc()
		}
		return new Response("unexpected", { status: 500 })
	}

const insertConnector = (testDb: TestDb, securityEnabled = true) =>
	Effect.promise(async () => {
		const sourceId = await insertTestSource(testDb, {
			orgId: ORG,
			platform: "gcp",
			name: "Google Cloud acme-prod",
		})
		await executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, metrics_enabled, security_enabled, created_by, created_at, updated_at, source_id)
			 VALUES ($1, $2, 'project', $3, $3, 'c', 'i', 't', $1, false, $4, 'user_1', now(), now(), $5)`,
			[CONNECTOR, ORG, PROJECT, securityEnabled, sourceId],
		)
	})

/** Google's signature, stubbed: GOOD_TOKEN is the connector's push account, OTHER_ACCOUNT_TOKEN another one. */
const fakeTokens = Layer.succeed(GooglePushTokens, {
	verify: (token, expected) =>
		(token === GOOD_TOKEN || token === OTHER_ACCOUNT_TOKEN) &&
		Str.endsWith(`/api/integrations/gcp/security/${CONNECTOR}`)(expected.audience)
			? Effect.succeed({
					audience: expected.audience,
					email:
						token === GOOD_TOKEN
							? "maple-push-0d3c6f1e6b8f4e6b9a1@acme-prod.iam.gserviceaccount.com"
							: "maple-push-0d3c6f1e6b8f4e6b9a1@attacker-proj.iam.gserviceaccount.com",
				})
			: Effect.fail(new PushTokenRejected({ message: "refused", reason: "bad_signature" })),
})

const world = (testDb: TestDb, fetch: typeof globalThis.fetch) =>
	Layer.mergeAll(
		Layer.effect(GcpSecurityFindingsService, GcpSecurityFindingsService.make),
		Layer.effect(GcpSecurityEventsService, GcpSecurityEventsService.make),
	).pipe(
		Layer.provideMerge(CloudSecurityStore.layer),
		Layer.provide(Layer.mergeAll(fakeTokens, FetchHttpClient.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
		Layer.provide(OrganizationFeatureFlagsService.allEnabled),
		Layer.provide(testDb.layer),
		Layer.provide(EnvTestLive),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
					MAPLE_API_BASE_URL: "https://api.maple.test",
					MAPLE_GCP_SERVICE_ACCOUNT_KEY: encodedKey,
				}),
			),
		),
	)

const rows = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite
			.query<{
				finding_id: string
				status: string
				severity: string
				account_id: string
				title: string
			}>(
				"SELECT finding_id, status, severity, account_id, title FROM cloud_security_findings ORDER BY finding_id",
			)
			.then((result) => result.rows),
	)

describe("readSccFinding", () => {
	it("maps an SCC finding to the stored shape", () => {
		const read = Option.getOrUndefined(readSccFinding(sccResult("a", { mute: "MUTED" }), PROJECT, NOW))
		assert.deepInclude(read?.finding, {
			findingId: "projects/123456789012/sources/42/locations/global/findings/a",
			type: "MISCONFIGURATION/PUBLIC_BUCKET_ACL",
			title: "Public bucket ACL",
			severity: "high",
			status: "archived",
			resourceType: "google.cloud.storage.Bucket",
			resourceId: "//storage.googleapis.com/acme-public-assets",
			resourceName: "acme-public-assets",
		})
		assert.strictEqual(read?.accountId, "acme-prod")
		assert.strictEqual(read?.region, "global")
	})

	it("closes an inactive finding, and keeps anything without a name out", () => {
		assert.strictEqual(
			Option.getOrUndefined(readSccFinding(sccResult("b", { state: "INACTIVE" }), PROJECT, NOW))
				?.finding.status,
			"resolved",
		)
		assert.isTrue(Option.isNone(readSccFinding({ finding: { category: "X" } }, PROJECT, NOW)))
	})

	it("titles categories in sentence case and keeps acronyms", () => {
		assert.deepStrictEqual(
			Arr.map(["OPEN_FIREWALL", "MFA_NOT_ENFORCED", "SQL_NO_ROOT_PASSWORD"], sccTitle),
			["Open firewall", "MFA not enforced", "SQL no root password"],
		)
		// Event Threat Detection's categories are titles already.
		assert.strictEqual(sccTitle("Persistence: IAM Anomalous Grant"), "Persistence: IAM Anomalous Grant")
	})
})

describe("sccFeedDue", () => {
	it("reads a pushed feed half-hourly and an off one hourly", () => {
		const pushed = { state: "enabled" as const, checkedAt: NOW - 10 * 60_000, pushedAt: NOW - 60_000 }
		const off = { state: "not_enabled" as const, checkedAt: NOW - 10 * 60_000, pushedAt: null }
		const polled = { state: "enabled" as const, checkedAt: NOW - 5 * 60_000, pushedAt: null }
		assert.deepStrictEqual(
			[
				sccFeedDue(undefined, NOW, 240_000),
				sccFeedDue(pushed, NOW, 240_000),
				sccFeedDue(off, NOW, 240_000),
				sccFeedDue(polled, NOW, 240_000),
			],
			[true, false, false, true],
		)
	})
})

describe("GcpSecurityFindingsService", () => {
	it.effect(
		"lists the scope's active findings as the reader, then closes what a later listing misses",
		() => {
			const testDb = createTestDb(trackedDbs)
			const calls: Calls = { impersonated: [], listed: [] }
			let page = [sccResult("a"), sccResult("b", { severity: "CRITICAL", category: "OPEN_FIREWALL" })]
			const fetch = stubFetch(calls, () => json({ listFindingsResults: page }))
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* insertConnector(testDb)
				const service = yield* GcpSecurityFindingsService
				const first = yield* service.pollAll
				assert.deepStrictEqual(first, {
					connectors: 1,
					failedConnectors: 0,
					findings: 2,
					resolved: 0,
				})
				assert.deepStrictEqual(calls.impersonated, [
					`/v1/projects/-/serviceAccounts/${READER}:generateAccessToken`,
				])
				assert.deepStrictEqual(calls.listed[0], {
					path: "/v2/projects/acme-prod/sources/-/locations/global/findings",
					filter: 'state="ACTIVE"',
					auth: "Bearer reader-token",
				})
				// Polled again once due: `a` is gone from the listing, so it closed.
				page = [sccResult("b", { severity: "CRITICAL", category: "OPEN_FIREWALL" })]
				yield* TestClock.adjust("5 minutes")
				const second = yield* service.pollAll
				assert.strictEqual(second.resolved, 1)
				assert.deepStrictEqual(
					Arr.map(yield* rows(testDb), (row) => [
						Str.slice(-1)(row.finding_id),
						row.status,
						row.severity,
					]),
					[
						["a", "resolved", "high"],
						["b", "active", "critical"],
					],
				)
			}).pipe(Effect.provide(world(testDb, fetch)))
		},
	)

	it.effect("records a refused read as denied and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Calls = { impersonated: [], listed: [] }
		const fetch = stubFetch(calls, () =>
			json({ error: { code: 403, status: "PERMISSION_DENIED", message: "no" } }, 403),
		)
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* insertConnector(testDb)
			const store = yield* CloudSecurityStore
			yield* (yield* GcpSecurityFindingsService).pollAll
			const [state] = yield* store.orgServiceStates(ORG)
			assert.deepStrictEqual(
				[state?.provider, state?.source, state?.state],
				["gcp", "security_command_center", "denied"],
			)
			assert.lengthOf(yield* rows(testDb), 0)
		}).pipe(Effect.provide(world(testDb, fetch)))
	})

	it.effect("leaves connectors with security off alone", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Calls = { impersonated: [], listed: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* insertConnector(testDb, false)
			assert.strictEqual((yield* (yield* GcpSecurityFindingsService).pollAll).connectors, 0)
			assert.lengthOf(calls.listed, 0)
		}).pipe(
			Effect.provide(
				world(
					testDb,
					stubFetch(calls, () => json({})),
				),
			),
		)
	})
})

describe("GcpSecurityEventsService", () => {
	const notification = (id: string, overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			notificationConfigName: "projects/acme-prod/locations/global/notificationConfigs/x",
			...sccResult(id, overrides),
		})

	it.effect(
		"stores a pushed finding once the poller has read the location, and marks the feed pushed",
		() => {
			const testDb = createTestDb(trackedDbs)
			const calls: Calls = { impersonated: [], listed: [] }
			return Effect.gen(function* () {
				yield* TestClock.setTime(NOW)
				yield* insertConnector(testDb)
				const events = yield* GcpSecurityEventsService
				// Before the first poll nothing is kept: the poller owns closing what is gone.
				assert.deepStrictEqual(yield* events.accept(CONNECTOR, GOOD_TOKEN, notification("n")), {
					outcome: "ignored",
					reason: "unknown_location",
				})
				yield* (yield* GcpSecurityFindingsService).pollAll
				assert.deepStrictEqual(
					yield* events.accept(CONNECTOR, GOOD_TOKEN, notification("n", { severity: "CRITICAL" })),
					{
						outcome: "stored",
						reason: null,
					},
				)
				const stored = Arr.findFirst(yield* rows(testDb), (row) => Str.endsWith("/n")(row.finding_id))
				assert.strictEqual(Option.getOrUndefined(stored)?.severity, "critical")
				const [state] = yield* (yield* CloudSecurityStore).orgServiceStates(ORG)
				assert.strictEqual(state?.pushedAt, NOW)
			}).pipe(
				Effect.provide(
					world(
						testDb,
						stubFetch(calls, () => json({})),
					),
				),
			)
		},
	)

	it.effect("refuses a bad token, an unknown connector and a body that is not JSON", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Calls = { impersonated: [], listed: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* insertConnector(testDb)
			const events = yield* GcpSecurityEventsService
			const reasonOf = (connector: string, token: string, body: string) =>
				Effect.map(Effect.result(events.accept(connector, token, body)), (result) =>
					Result.isSuccess(result)
						? result.success.outcome
						: result.failure._tag === "@maple/backend/cloud-security/GcpSecurityEventRejected"
							? result.failure.reason
							: "persistence",
				)
			assert.deepStrictEqual(
				[
					yield* reasonOf(CONNECTOR, "forged", notification("x")),
					// Signed by Google, but as an account in another project: not this connector's subscription.
					yield* reasonOf(CONNECTOR, OTHER_ACCOUNT_TOKEN, notification("x")),
					yield* reasonOf("1d3c6f1e-6b8f-4e6b-9a1e-2f4c5d6e7f80", GOOD_TOKEN, notification("x")),
					yield* reasonOf("not-a-uuid", GOOD_TOKEN, notification("x")),
					yield* reasonOf(CONNECTOR, GOOD_TOKEN, "{oops"),
				],
				["bad_token", "bad_token", "bad_token", "unknown_connector", "malformed"],
			)
		}).pipe(
			Effect.provide(
				world(
					testDb,
					stubFetch(calls, () => json({})),
				),
			),
		)
	})

	it.effect("acknowledges but drops a push for a connector whose security is off", () => {
		const testDb = createTestDb(trackedDbs)
		const calls: Calls = { impersonated: [], listed: [] }
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			yield* insertConnector(testDb, false)
			const events = yield* GcpSecurityEventsService
			assert.deepStrictEqual(yield* events.accept(CONNECTOR, GOOD_TOKEN, notification("x")), {
				outcome: "ignored",
				reason: "security_off",
			})
		}).pipe(
			Effect.provide(
				world(
					testDb,
					stubFetch(calls, () => json({})),
				),
			),
		)
	})
})
