import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId, VercelConnectRequest, VercelSettingsRequest } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { publicSourceId } from "@maple/backend/services/integrations/integration-sources"
import { SourceId } from "@maple/primitives"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { VercelIntegrationService } from "./VercelIntegrationService"

const now = Date.UTC(2026, 9, 19, 12, 0, 0)
const minute = 60_000

const trackedDbs: TestDb[] = []

afterEach(async () => {
	await cleanupTestDbs(trackedDbs)
})

const makeConfig = () =>
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
			MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
		}),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)
const asObject = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))

const orgId = asOrgId("org_vercel")
const userId = asUserId("user_1")
const LOGS_ENDPOINT = "https://ingest.test/v1/logpush/vercel?maple_org=org_vercel"
const TRACES_ENDPOINT = "https://ingest.test/v1/traces?maple_org=org_vercel"
const AI_GATEWAY_ENDPOINT = "https://ingest.test/v1/vercel/ai-gateway?maple_org=org_vercel"
const SPEED_INSIGHTS_ENDPOINT = "https://ingest.test/v1/vercel/speed-insights?maple_org=org_vercel"
const WEB_ANALYTICS_ENDPOINT = "https://ingest.test/v1/vercel/web-analytics?maple_org=org_vercel"
const AUDIT_LOG_ENDPOINT = "https://ingest.test/v1/vercel/audit-log?maple_org=org_vercel"

interface VercelCall {
	readonly method: string
	readonly path: string
	readonly teamId: string | null
	readonly body: unknown
	readonly authorization: string | null
}

interface Deployment {
	readonly uid: string
	readonly created: number
	readonly readyState: string
	readonly target: string | null
	readonly projectId: string
	readonly buildingAt?: number
	readonly ready?: number
	readonly errorCode?: string
	readonly errorMessage?: string | null
}

interface FakeDrain {
	readonly id: string
	readonly teamId: string
	readonly createdAt: number
	status: string
	/** The create body with every PATCH merged in. */
	body: Readonly<Record<string, unknown>>
}

/** A fake Vercel account: its teams, `prj_web` plus any project its deployments name, its deployments, and the drains on its teams. */
interface Fake {
	readonly calls: Array<VercelCall>
	readonly drains: Map<string, FakeDrain>
	mode: "ok" | "token_rejected"
	teams: ReadonlyArray<{
		readonly id: string
		readonly slug: string
		readonly name: string
		readonly billing?: { readonly plan: string }
	}>
	deployments: ReadonlyArray<Deployment>
	created: number
	/** Answers a call before the default handling when it returns a response. */
	respond: (
		call: VercelCall,
		signal: AbortSignal | null | undefined,
	) => Response | Promise<Response> | undefined
}

const makeFake = (deployments?: ReadonlyArray<Deployment>): Fake => ({
	calls: [],
	drains: new Map(),
	mode: "ok",
	teams: [{ id: "team_1", slug: "acme", name: "Acme" }],
	created: 0,
	respond: () => undefined,
	deployments: deployments ?? [
		{
			uid: "dpl_1",
			created: now - 60 * minute,
			readyState: "READY",
			target: "production",
			projectId: "prj_web",
		},
		{
			uid: "dpl_2",
			created: now - 10 * minute,
			readyState: "BUILDING",
			target: null,
			projectId: "prj_web",
		},
	],
})

/** Adds a drain the way Vercel stores a create. */
const addDrain = (fake: Fake, teamId: string, body: unknown) => {
	fake.created++
	const drain: FakeDrain = {
		id: `drn_${fake.created}`,
		teamId,
		createdAt: now + fake.created,
		status: "enabled",
		body: asObject(body),
	}
	fake.drains.set(drain.id, drain)
	return drain
}

const logDrainBody = (endpoint: string) => ({
	name: "Maple logs",
	projects: "some",
	projectIds: ["prj_web"],
	schemas: { log: { version: "v1" } },
	delivery: { type: "http", endpoint, encoding: "ndjson", compression: "none", headers: {} },
	sampling: [{ type: "head_sampling", rate: 0.5 }],
})

const traceDrainBody = (endpoint: string) => ({
	name: "Maple traces",
	projects: "some",
	projectIds: ["prj_web"],
	schemas: { trace: { version: "v1" } },
	delivery: { type: "otlphttp", endpoint: { traces: endpoint }, encoding: "proto", headers: {} },
	sampling: [{ type: "head_sampling", rate: 0.5 }],
})

/** The listing Vercel answers with: headers redacted, `projects` not echoed. */
const listed = (drain: FakeDrain) => {
	const { projects: _projects, projectIds, delivery, ...rest } = drain.body
	return {
		...rest,
		id: drain.id,
		createdAt: drain.createdAt,
		status: drain.status,
		...(Arr.isArray(projectIds) ? { projectIds } : undefined),
		delivery: { ...asObject(delivery), headers: {} },
	}
}

const { json } = VendorFake

const toCall = (request: VendorFake.VendorFakeRequest): VercelCall => ({
	method: request.method,
	path: request.path,
	teamId: request.search.get("teamId"),
	body: request.body === "" ? null : decodeJson(request.body),
	authorization: request.authorization,
})

/** The drain a request names, on the team it names; a 404 answer when there is none. */
const drainOf = (fake: Fake, call: VercelCall) => {
	const drain = fake.drains.get(Str.split("/")(call.path)[3] ?? "")
	return drain === undefined || drain.teamId !== (call.teamId ?? "")
		? json({ error: { code: "not_found", message: "Drain not found" } }, 404)
		: drain
}

const fakeVercel = (fake: Fake) =>
	VendorFake.make({
		routes: [
			{
				respond: (request) => {
					const call = toCall(request)
					fake.calls.push(call)
					return fake.respond(call, request.signal)
				},
			},
			{
				respond: () =>
					fake.mode === "token_rejected"
						? json({ error: { code: "forbidden", message: "Not authorized" } }, 403)
						: undefined,
			},
			{ path: "/v2/teams", respond: () => json({ teams: fake.teams, pagination: { next: null } }) },
			{
				path: "/v10/projects",
				respond: () =>
					json({
						projects: [
							{
								id: "prj_web",
								name: "web",
								framework: "nextjs",
								targets: { production: { id: "dpl_1" } },
							},
							...Arr.map(
								Arr.filter(
									[...new Set(Arr.map(fake.deployments, (d) => d.projectId))],
									(id) => id !== "prj_web",
								),
								(id) => ({ id, name: id, framework: null }),
							),
						],
						pagination: { next: null },
					}),
			},
			{
				path: "/v7/deployments",
				respond: () =>
					json({
						deployments: Arr.map(fake.deployments, (d) => ({
							...d,
							url: `${d.uid}.vercel.app`,
							meta: { githubCommitSha: `sha_${d.uid}`, githubCommitRef: "main" },
							creator: { username: "dev" },
						})),
						pagination: { next: null },
					}),
			},
			{
				method: "POST",
				path: "/v1/drains",
				respond: (request) => {
					const drain = addDrain(fake, request.search.get("teamId") ?? "", toCall(request).body)
					return json({ id: drain.id, status: drain.status })
				},
			},
			{
				method: "GET",
				path: "/v1/drains",
				respond: (request) =>
					json({
						drains: Arr.map(
							Arr.filter(
								[...fake.drains.values()],
								(d) => d.teamId === (request.search.get("teamId") ?? ""),
							),
							listed,
						),
					}),
			},
			{
				method: "DELETE",
				path: /^\/v1\/drains\/[^/]+$/,
				respond: (request) => {
					const drain = drainOf(fake, toCall(request))
					if (drain instanceof Response) return drain
					fake.drains.delete(drain.id)
					return VendorFake.empty(204)
				},
			},
			{
				path: /^\/v1\/drains\/[^/]+$/,
				respond: (request) => {
					const call = toCall(request)
					const drain = drainOf(fake, call)
					if (drain instanceof Response) return drain
					if (call.method === "PATCH") {
						const patch = asObject(call.body)
						drain.body = { ...drain.body, ...patch }
						if (typeof patch.status === "string") drain.status = patch.status
					}
					return json({ id: drain.id, status: drain.status })
				},
			},
		],
	})

const makeLayer = (testDb: TestDb, fake: VendorFake.VendorFake) =>
	Layer.effect(VercelIntegrationService, VercelIntegrationService.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer)),
		Layer.provide(fake.layer),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig()),
	)

const run = <A, E>(
	testDb: TestDb,
	fake: Fake,
	effect: Effect.Effect<A, E, VercelIntegrationService | OrgIngestKeysService>,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(now)
		return yield* effect
	}).pipe(Effect.provide(makeLayer(testDb, fakeVercel(fake))))

const connectRequest = (overrides: Partial<VercelConnectRequest> = {}) =>
	new VercelConnectRequest({
		token: "vc_token_123",
		teamId: "team_1",
		projectScope: "some",
		projectIds: ["prj_web"],
		samplingRate: 0.5,
		logsEnabled: true,
		tracesEnabled: true,
		...overrides,
	})

const connect = (overrides: Partial<VercelConnectRequest> = {}) =>
	VercelIntegrationService.use((vercel) => vercel.connect(orgId, userId, connectRequest(overrides)))

const callsTo = (fake: Fake, method: string, path: string) =>
	Arr.filter(fake.calls, (call) => call.method === method && Str.startsWith(path)(call.path))

/** Ids of the drains on `teamId` that deliver to `endpoint`, oldest first. */
const drainsTo = (fake: Fake, endpoint: string, teamId = "team_1") =>
	Arr.map(
		Arr.filter(
			[...fake.drains.values()],
			(drain) => drain.teamId === teamId && Str.includes(endpoint)(JSON.stringify(drain.body)),
		),
		(drain) => drain.id,
	)

const isTraceCreate = (call: VercelCall) =>
	call.method === "POST" &&
	call.path === "/v1/drains" &&
	Str.includes("Maple traces")(JSON.stringify(call.body))

/** The `src_` id of the connection's pull source, as the drains send it. */
const vercelSourceId = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{ id: string }>(
			testDb,
			"SELECT source_id AS id FROM vercel_connections WHERE org_id = $1",
			[orgId],
		),
	).pipe(Effect.map((row) => publicSourceId(Schema.decodeSync(SourceId)(row!.id))))

const vercelError = (status: number, message: string) => json({ error: { message } }, status)

const poll = () => VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId))
const status = () => VercelIntegrationService.use((vercel) => vercel.getStatus(orgId))
const disconnect = () => VercelIntegrationService.use((vercel) => vercel.disconnect(orgId))

describe("VercelIntegrationService", () => {
	it.effect(
		"connect creates a log, a trace and an AI Gateway drain carrying the org's ingest key and source",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					const connected = yield* connect()
					const keys = yield* OrgIngestKeysService.use((service) =>
						service.getOrCreate(orgId, userId),
					)
					const headers = {
						authorization: `Bearer ${keys.privateKey}`,
						"x-maple-source-id": yield* vercelSourceId(testDb),
					}
					const created = Arr.map(callsTo(fake, "POST", "/v1/drains"), (call) => call.body)
					assert.deepStrictEqual(created, [
						{
							name: "Maple logs",
							projects: "some",
							projectIds: ["prj_web"],
							schemas: { log: { version: "v1" } },
							delivery: {
								type: "http",
								endpoint: LOGS_ENDPOINT,
								encoding: "ndjson",
								compression: "none",
								headers,
							},
							sampling: [{ type: "head_sampling", rate: 0.5 }],
						},
						{
							name: "Maple traces",
							projects: "some",
							projectIds: ["prj_web"],
							schemas: { trace: { version: "v1" } },
							delivery: {
								type: "otlphttp",
								endpoint: { traces: TRACES_ENDPOINT },
								encoding: "proto",
								headers,
							},
							sampling: [{ type: "head_sampling", rate: 0.5 }],
						},
						// Sampled usage events would undercount cost: no sampling at a rate below 1.
						{
							name: "Maple AI Gateway",
							projects: "some",
							projectIds: ["prj_web"],
							schemas: { ai_gateway: { version: "v1" } },
							delivery: {
								type: "http",
								endpoint: AI_GATEWAY_ENDPOINT,
								encoding: "json",
								compression: "none",
								headers,
							},
						},
					])
					assert.isTrue(
						Arr.every(fake.calls, (call) => call.authorization === "Bearer vc_token_123"),
					)
					assert.deepStrictEqual(
						{ ...connected.team },
						{ id: "team_1", slug: "acme", name: "Acme" },
					)
					assert.deepStrictEqual(
						{ ...connected.drains.logs },
						{ id: "drn_1", status: "enabled", lastError: null },
					)
					assert.deepStrictEqual(
						{ ...connected.drains.traces },
						{ id: "drn_2", status: "enabled", lastError: null },
					)
					assert.deepStrictEqual(
						{ ...connected.drains.aiGateway },
						{ id: "drn_3", status: "enabled", lastError: null },
					)
					// The opt-in drains stay off unless asked for.
					assert.deepStrictEqual(
						[
							connected.speedInsightsEnabled,
							connected.webAnalyticsEnabled,
							connected.auditLogEnabled,
						],
						[false, false, false],
					)
					assert.isTrue(connected.aiGatewayEnabled)
					// The first sync ran inline and left the drains as they were.
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
					const project = connected.projects[0]
					assert.strictEqual(project?.forwarded, true)
					assert.strictEqual(project?.productionDeployment?.id, "dpl_1")
					assert.strictEqual(project?.latestDeployment?.id, "dpl_2")
					assert.strictEqual(project?.latestDeployment?.commitSha, "sha_dpl_2")
					assert.isNotNull(connected.lastSuccessAt)
					const row = yield* Effect.promise(() =>
						queryFirstRow<{ token_ciphertext: string }>(
							testDb,
							"SELECT token_ciphertext FROM vercel_connections WHERE org_id = $1",
							[orgId],
						),
					)
					assert.notInclude(row!.token_ciphertext, "vc_token_123")
				}),
			)
		},
	)

	it.effect(
		"the opt-in drains are never sampled, the audit log covers the whole team, and disconnect removes them",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					const connected = yield* connect({
						speedInsightsEnabled: true,
						webAnalyticsEnabled: true,
						auditLogEnabled: true,
					})
					const headers = {
						authorization: `Bearer ${(yield* OrgIngestKeysService.use((service) => service.getOrCreate(orgId, userId))).privateKey}`,
						"x-maple-source-id": yield* vercelSourceId(testDb),
					}
					const delivery = (endpoint: string) => ({
						type: "http",
						endpoint,
						encoding: "json",
						compression: "none",
						headers,
					})
					const created = Arr.map(callsTo(fake, "POST", "/v1/drains"), (call) => call.body)
					assert.deepStrictEqual(Arr.drop(created, 3), [
						{
							name: "Maple Speed Insights",
							projects: "some",
							projectIds: ["prj_web"],
							schemas: { speed_insights: { version: "v1" } },
							delivery: delivery(SPEED_INSIGHTS_ENDPOINT),
						},
						{
							name: "Maple Web Analytics",
							projects: "some",
							projectIds: ["prj_web"],
							schemas: { analytics: { version: "v2" } },
							delivery: delivery(WEB_ANALYTICS_ENDPOINT),
						},
						// Team-wide, whatever projects the other drains forward.
						{
							name: "Maple audit log",
							projects: "all",
							schemas: { audit_log: { version: "v1" } },
							delivery: delivery(AUDIT_LOG_ENDPOINT),
						},
					])
					assert.deepStrictEqual(
						[
							connected.drains.speedInsights?.id,
							connected.drains.webAnalytics?.id,
							connected.drains.auditLog?.id,
						],
						["drn_4", "drn_5", "drn_6"],
					)
					// The audit log drain matches the settings even though the connection picks projects.
					yield* poll()
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)

					yield* disconnect()
					assert.strictEqual(fake.drains.size, 0)
				}),
			)
		},
	)

	it.effect(
		"a drain Vercel refuses for the team's plan is marked errored and the other drains still converge",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			const refuses = (call: VercelCall, schema: string) =>
				call.method === "POST" &&
				call.path === "/v1/drains" &&
				Str.includes(`"${schema}"`)(JSON.stringify(call.body))
			fake.respond = (call) =>
				refuses(call, "audit_log")
					? vercelError(403, "Audit Log drains are only available on Enterprise plans")
					: refuses(call, "speed_insights")
						? vercelError(400, "Speed Insights Plus is required")
						: undefined
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					const connected = yield* connect({ auditLogEnabled: true })
					assert.deepStrictEqual(
						{ ...connected.drains.auditLog },
						{
							id: null,
							status: "errored",
							lastError: "Audit Log drains are only available on Enterprise plans",
						},
					)
					assert.deepStrictEqual(
						[
							connected.drains.logs?.status,
							connected.drains.traces?.status,
							connected.drains.aiGateway?.status,
						],
						["enabled", "enabled", "enabled"],
					)
					assert.isNull(connected.lastError)

					const updated = yield* VercelIntegrationService.use((vercel) =>
						vercel.updateSettings(
							orgId,
							VercelSettingsRequest.make({
								speedInsightsEnabled: true,
								webAnalyticsEnabled: true,
							}),
						),
					)
					assert.strictEqual(updated.drains.speedInsights?.status, "errored")
					assert.strictEqual(
						updated.drains.speedInsights?.lastError,
						"Speed Insights Plus is required",
					)
					assert.strictEqual(updated.drains.webAnalytics?.status, "enabled")

					// The poll tries the refused drains again, and re-keys nothing: every drain that exists has the key.
					const posts = callsTo(fake, "POST", "/v1/drains").length
					const summary = yield* poll()
					assert.strictEqual(summary.failures, 0)
					assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, posts + 2)
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
				}),
			)
		},
	)

	it.effect("connect leaves sampling out at a rate of 1 and fails on a token Vercel rejects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect({
					samplingRate: 1,
					tracesEnabled: false,
					aiGatewayEnabled: false,
					projectScope: "all",
					projectIds: [],
				})
				const created = callsTo(fake, "POST", "/v1/drains")
				assert.strictEqual(created.length, 1)
				assert.notProperty(created[0]?.body, "sampling")
				assert.notProperty(created[0]?.body, "projectIds")

				fake.mode = "token_rejected"
				const error = yield* Effect.flip(connect())
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
			}),
		)
	})

	it.effect("turning logs off deletes the log drain and keeps the trace drain", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const updated = yield* VercelIntegrationService.use((vercel) =>
					vercel.updateSettings(
						orgId,
						VercelSettingsRequest.make({ logsEnabled: false, samplingRate: 1 }),
					),
				)
				assert.deepStrictEqual(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
					["/v1/drains/drn_1"],
				)
				const patched = callsTo(fake, "PATCH", "/v1/drains")
				assert.deepStrictEqual(
					Arr.map(patched, (call) => call.path),
					["/v1/drains/drn_2"],
				)
				// An update clears the sampling rule the drain was created with and re-enables the drain.
				assert.deepInclude(patched[0]?.body, { sampling: [], status: "enabled" })
				assert.isNull(updated.drains.logs)
				assert.strictEqual(updated.drains.traces?.id, "drn_2")
				assert.isFalse(updated.logsEnabled)
				// Applied once: the next poll finds nothing to change.
				yield* poll()
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 1)
			}),
		)
	})

	it.effect("turning AI Gateway off deletes its drain and leaves the log and trace drains alone", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const updated = yield* VercelIntegrationService.use((vercel) =>
					vercel.updateSettings(orgId, VercelSettingsRequest.make({ aiGatewayEnabled: false })),
				)
				assert.deepStrictEqual(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
					["/v1/drains/drn_3"],
				)
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
				assert.isFalse(updated.aiGatewayEnabled)
				assert.isNull(updated.drains.aiGateway)
				assert.deepStrictEqual(
					[updated.drains.logs?.id, updated.drains.traces?.id],
					["drn_1", "drn_2"],
				)
			}),
		)
	})

	it.effect(
		"a poll strips a sampling rule added to the AI Gateway drain and keeps the others sampled",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					const aiGateway = fake.drains.get("drn_3")!
					aiGateway.body = { ...aiGateway.body, sampling: [{ type: "head_sampling", rate: 0.5 }] }
					const summary = yield* poll()
					assert.strictEqual(summary.drainsRepaired, 1)
					const patched = callsTo(fake, "PATCH", "/v1/drains")
					assert.deepStrictEqual(
						Arr.map(patched, (call) => call.path),
						["/v1/drains/drn_3"],
					)
					assert.deepInclude(patched[0]?.body, { sampling: [] })
					yield* poll()
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 1)
				}),
			)
		},
	)

	it.effect("a poll deletes duplicate drains of the org and leaves other drains on the team alone", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				// Newer than the ones on record, yet the stored ids win.
				const extraLogs = addDrain(fake, "team_1", logDrainBody(LOGS_ENDPOINT))
				const extraTraces = addDrain(fake, "team_1", traceDrainBody(TRACES_ENDPOINT))
				const otherOrg = addDrain(
					fake,
					"team_1",
					logDrainBody("https://ingest.test/v1/logpush/vercel?maple_org=org_other"),
				)
				const otherEndpoint = addDrain(
					fake,
					"team_1",
					traceDrainBody("https://collector.example/v1/traces"),
				)
				const summary = yield* poll()
				assert.strictEqual(summary.drainsRepaired, 2)
				assert.sameMembers(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
					[`/v1/drains/${extraLogs.id}`, `/v1/drains/${extraTraces.id}`],
				)
				assert.sameMembers(
					[...fake.drains.keys()],
					["drn_1", "drn_2", "drn_3", otherOrg.id, otherEndpoint.id],
				)
				const after = yield* status()
				assert.deepStrictEqual([after.drains.logs?.id, after.drains.traces?.id], ["drn_1", "drn_2"])
			}),
		)
	})

	it.effect(
		"a poll patches a drain edited on Vercel back to the settings and leaves a disabled one off",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					const logs = fake.drains.get("drn_1")!
					logs.body = { ...logs.body, sampling: [], projectIds: ["prj_other"] }
					fake.drains.get("drn_2")!.status = "disabled"
					const summary = yield* poll()
					assert.strictEqual(summary.drainsRepaired, 1)
					const patched = callsTo(fake, "PATCH", "/v1/drains")
					assert.deepStrictEqual(
						Arr.map(patched, (call) => call.path),
						["/v1/drains/drn_1"],
					)
					assert.deepInclude(patched[0]?.body, {
						projectIds: ["prj_web"],
						sampling: [{ type: "head_sampling", rate: 0.5 }],
					})
					// The team's owner may have turned it off on purpose: only a settings save turns it back on.
					assert.notProperty(asObject(patched[0]?.body), "status")
					assert.strictEqual((yield* status()).drains.traces?.status, "disabled")
					yield* poll()
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 1)

					yield* VercelIntegrationService.use((vercel) =>
						vercel.updateSettings(orgId, VercelSettingsRequest.make({})),
					)
					assert.deepInclude(callsTo(fake, "PATCH", "/v1/drains/drn_2")[0]?.body, {
						status: "enabled",
					})
					assert.strictEqual((yield* status()).drains.traces?.status, "enabled")
				}),
			)
		},
	)

	it.effect(
		"a picked project deleted on Vercel is dropped from the settings instead of patched every poll",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect({ projectIds: ["prj_web", "prj_gone"] })
					// Vercel drops a deleted project from every drain that named it.
					for (const drain of fake.drains.values())
						drain.body = { ...drain.body, projectIds: ["prj_web"] }
					yield* TestClock.adjust("61 minutes")
					yield* poll()
					assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
					assert.deepStrictEqual((yield* status()).projectIds, ["prj_web"])
				}),
			)
		},
	)

	it.effect("all picked projects deleted on Vercel empties the selection and writes no drain", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect({ projectIds: ["prj_gone"] })
				for (const drain of fake.drains.values()) drain.body = { ...drain.body, projectIds: [] }
				fake.drains.delete("drn_2")
				yield* TestClock.adjust("61 minutes")
				yield* poll()
				yield* poll()
				assert.deepStrictEqual((yield* status()).projectIds, [])
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 3)
			}),
		)
	})

	it.effect("a poll re-creates a drain that was deleted on Vercel", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.drains.delete("drn_2")
				const summary = yield* poll()
				assert.strictEqual(summary.drainsRepaired, 1)
				const after = yield* status()
				assert.deepStrictEqual(
					{ ...after.drains.traces },
					{ id: "drn_4", status: "enabled", lastError: null },
				)
				assert.strictEqual(after.drains.logs?.id, "drn_1")
			}),
		)
	})

	it.effect(
		"a connect cut off after creating a drain is finished by the next poll without a second drain",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			let reached = (): void => undefined
			const traceCreated = new Promise<void>((resolve) => {
				reached = resolve
			})
			// Vercel creates the trace drain, then the request hangs until the caller gives up.
			fake.respond = (call, signal) => {
				if (!isTraceCreate(call)) return undefined
				addDrain(fake, "team_1", call.body)
				reached()
				return new Promise((_, reject) =>
					signal?.addEventListener("abort", () => reject(signal.reason)),
				)
			}
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					const connecting = yield* Effect.forkChild(connect())
					yield* Effect.promise(() => traceCreated)
					yield* Fiber.interrupt(connecting)
					fake.respond = () => undefined
					yield* poll()
					// Only the AI Gateway drain, which the cut-off connect never reached, is created.
					assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 3)
					assert.deepStrictEqual(drainsTo(fake, TRACES_ENDPOINT), ["drn_2"])
					const after = yield* status()
					assert.deepStrictEqual(
						[after.drains.logs?.id, after.drains.traces?.id],
						["drn_1", "drn_2"],
					)
				}),
			)
		},
	)

	it.effect("two connects at once end with one connection and, after a poll, one drain per kind", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		// Both connects list the team's drains before either creates one.
		let arrived = 0
		let releaseLists = (): void => undefined
		const bothListed = new Promise<void>((resolve) => {
			releaseLists = resolve
		})
		fake.respond = async (call) => {
			if (call.method !== "GET" || call.path !== "/v1/drains" || arrived >= 2) return undefined
			arrived++
			if (arrived === 2) releaseLists()
			await bothListed
			return undefined
		}
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* Effect.all([connect(), connect()], { concurrency: 2 })
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 6)
				yield* poll()
				const logs = drainsTo(fake, LOGS_ENDPOINT)
				const traces = drainsTo(fake, TRACES_ENDPOINT)
				assert.strictEqual(logs.length, 1)
				assert.strictEqual(traces.length, 1)
				assert.strictEqual(drainsTo(fake, AI_GATEWAY_ENDPOINT).length, 1)
				const after = yield* status()
				assert.deepStrictEqual([after.drains.logs?.id, after.drains.traces?.id], [logs[0], traces[0]])
				const rows = yield* Effect.promise(() =>
					queryFirstRow<{ count: number }>(
						testDb,
						"SELECT count(*)::int AS count FROM vercel_connections WHERE org_id = $1",
						[orgId],
					),
				)
				assert.strictEqual(rows?.count, 1)
			}),
		)
	})

	it.effect("disconnect deletes every drain Maple made for the org and the rows", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const duplicate = addDrain(fake, "team_1", logDrainBody(LOGS_ENDPOINT))
				const otherOrg = addDrain(
					fake,
					"team_1",
					traceDrainBody("https://ingest.test/v1/traces?maple_org=org_other"),
				)
				// A drain Vercel answers 410 Gone for counts as deleted.
				fake.respond = (call) =>
					call.method === "DELETE" && call.path === "/v1/drains/drn_2"
						? vercelError(410, "Gone")
						: undefined
				const result = yield* disconnect()
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: true })
				assert.sameMembers(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
					[
						"/v1/drains/drn_1",
						"/v1/drains/drn_2",
						"/v1/drains/drn_3",
						`/v1/drains/${duplicate.id}`,
					],
				)
				assert.isTrue(fake.drains.has(otherOrg.id))
				const after = yield* status()
				assert.isFalse(after.connected)
				assert.deepStrictEqual(after.projects, [])
			}),
		)
	})

	it.effect(
		"disconnect still deletes the other drains and the rows when the log drain delete fails",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					fake.respond = (call) =>
						call.method === "DELETE" && call.path === "/v1/drains/drn_1"
							? vercelError(502, "bad gateway")
							: undefined
					// A 5xx on a delete is retried; the clock moves the back-off along.
					const result = yield* VendorFake.elapsing(disconnect())
					assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: false })
					assert.deepStrictEqual(
						Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
						// The failing delete is sent three times before the disconnect moves on.
						[
							"/v1/drains/drn_1",
							"/v1/drains/drn_1",
							"/v1/drains/drn_1",
							"/v1/drains/drn_2",
							"/v1/drains/drn_3",
						],
					)
					assert.isFalse((yield* status()).connected)
				}),
			)
		},
	)

	it.effect(
		"a settings save that finds the org disconnected meanwhile deletes the drain it created",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			let reached = (): void => undefined
			const listing = new Promise<void>((resolve) => {
				reached = resolve
			})
			let release = (): void => undefined
			const disconnected = new Promise<void>((resolve) => {
				release = resolve
			})
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect({ logsEnabled: false })
					let held = false
					fake.respond = async (call) => {
						if (held || call.method !== "GET" || call.path !== "/v1/drains") return undefined
						held = true
						reached()
						await disconnected
						return undefined
					}
					const saving = yield* Effect.forkChild(
						Effect.exit(
							VercelIntegrationService.use((vercel) =>
								vercel.updateSettings(
									orgId,
									VercelSettingsRequest.make({ logsEnabled: true }),
								),
							),
						),
					)
					yield* Effect.promise(() => listing)
					assert.deepStrictEqual(yield* disconnect(), { disconnected: true, drainsRemoved: true })
					release()
					yield* Fiber.join(saving)
					// The save created the log drain after the disconnect, then took it back.
					assert.isAbove(callsTo(fake, "POST", "/v1/drains").length, 1)
					assert.strictEqual(fake.drains.size, 0)
				}),
			)
		},
	)

	it.effect("a poll that finds the org disconnected meanwhile deletes the drains it re-created", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		let reached = (): void => undefined
		const pollListing = new Promise<void>((resolve) => {
			reached = resolve
		})
		let release = (): void => undefined
		const disconnected = new Promise<void>((resolve) => {
			release = resolve
		})
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				let held = false
				fake.respond = async (call) => {
					if (held || call.method !== "GET" || call.path !== "/v1/drains") return undefined
					held = true
					reached()
					await disconnected
					return undefined
				}
				const polling = yield* Effect.forkChild(poll())
				yield* Effect.promise(() => pollListing)
				assert.deepStrictEqual(yield* disconnect(), { disconnected: true, drainsRemoved: true })
				release()
				const summary = yield* Fiber.join(polling)
				assert.strictEqual(summary.skipped, "disconnected")
				// The poll saw no drains and created three, then took them back.
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 6)
				assert.strictEqual(fake.drains.size, 0)
			}),
		)
	})

	it.effect("a poll after the private ingest key rolled rewrites every drain with the new key", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const rolled = yield* OrgIngestKeysService.use((keys) => keys.rerollPrivate(orgId, userId))
				const summary = yield* poll()
				assert.strictEqual(summary.drainsRepaired, 3)
				const patched = callsTo(fake, "PATCH", "/v1/drains")
				assert.deepStrictEqual(
					Arr.map(patched, (call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2", "/v1/drains/drn_3"],
				)
				const deliveries = new Map<string, object>([
					[
						"/v1/drains/drn_1",
						{ type: "http", endpoint: LOGS_ENDPOINT, encoding: "ndjson", compression: "none" },
					],
					[
						"/v1/drains/drn_2",
						{ type: "otlphttp", endpoint: { traces: TRACES_ENDPOINT }, encoding: "proto" },
					],
					[
						"/v1/drains/drn_3",
						{
							type: "http",
							endpoint: AI_GATEWAY_ENDPOINT,
							encoding: "json",
							compression: "none",
						},
					],
				])
				for (const call of patched) {
					assert.deepInclude(call.body, {
						delivery: {
							...deliveries.get(call.path),
							headers: {
								authorization: `Bearer ${rolled.privateKey}`,
								"x-maple-source-id": yield* vercelSourceId(testDb),
							},
						},
					})
				}
				// The AI Gateway drain's update clears sampling rather than taking the connection's rate.
				assert.deepInclude(patched[2]?.body, { sampling: [] })
				// Re-keyed once: the next poll only reads the drains.
				yield* poll()
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 3)
			}),
		)
	})

	it.effect("a re-key that fails on one drain is retried on the next poll", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				yield* OrgIngestKeysService.use((keys) => keys.rerollPrivate(orgId, userId))
				fake.respond = (call) =>
					call.method === "PATCH" && call.path === "/v1/drains/drn_2"
						? vercelError(500, "internal")
						: undefined
				yield* poll()
				fake.respond = () => undefined
				const retried = yield* poll()
				assert.strictEqual(retried.drainsRepaired, 3)
				assert.deepStrictEqual(
					Arr.map(callsTo(fake, "PATCH", "/v1/drains"), (call) => call.path),
					[
						"/v1/drains/drn_1",
						"/v1/drains/drn_2",
						"/v1/drains/drn_3",
						"/v1/drains/drn_1",
						"/v1/drains/drn_2",
						"/v1/drains/drn_3",
					],
				)
			}),
		)
	})

	it.effect("a drain 403 while polling is recorded on the drain without pausing the token", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const logs = fake.drains.get("drn_1")!
				logs.body = { ...logs.body, sampling: [] }
				fake.respond = (call) =>
					call.method === "PATCH" && call.path === "/v1/drains/drn_1"
						? vercelError(403, "Drains are not available on the Hobby plan")
						: undefined
				const summary = yield* poll()
				assert.strictEqual(summary.failures, 1)
				const after = yield* status()
				assert.isFalse(after.authFailed)
				assert.include(after.lastError ?? "", "Hobby plan")
				assert.strictEqual(after.drains.logs?.status, "enabled")
				assert.include(after.drains.logs?.lastError ?? "", "Hobby plan")
				assert.strictEqual(after.drains.traces?.status, "enabled")
			}),
		)
	})

	it.effect("a token rejected while polling pauses the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.mode = "token_rejected"
				yield* poll()
				assert.isTrue((yield* status()).authFailed)
				const all = yield* VercelIntegrationService.use((vercel) => vercel.pollAllOrgs)
				assert.strictEqual(all.orgs, 0)
			}),
		)
	})

	it.effect("a 429 holds the org off polling, through a settings save, and shows as its last error", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.respond = (call) =>
					call.path === "/v7/deployments" ? vercelError(429, "Too many requests") : undefined
				const limited = yield* poll()
				assert.strictEqual(limited.skipped, "rate_limited")
				assert.include((yield* status()).lastError ?? "", "429")
				fake.respond = () => undefined
				yield* VercelIntegrationService.use((vercel) =>
					vercel.updateSettings(orgId, VercelSettingsRequest.make({ samplingRate: 1 })),
				)
				// The hold reads apart from an overlapping tick's lease.
				assert.strictEqual((yield* poll()).skipped, "held")
			}),
		)
	})

	it.effect("a 429 with a long Retry-After holds the org that long, not the default 15 minutes", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.respond = (call) =>
					call.path === "/v7/deployments"
						? json({ error: { message: "Too many requests" } }, 429, { "retry-after": "1800" })
						: undefined
				assert.strictEqual((yield* poll()).skipped, "rate_limited")
				fake.respond = () => undefined
				yield* TestClock.setTime(now + 20 * minute)
				assert.strictEqual((yield* poll()).skipped, "held")
				yield* TestClock.setTime(now + 31 * minute)
				assert.isNull((yield* poll()).skipped)
			}),
		)
	})

	it.effect("deployments are upserted and pruned to the newest 50 per project", () => {
		const testDb = createTestDb(trackedDbs)
		const many = Array.from({ length: 55 }, (_, index) => ({
			uid: `dpl_${index}`,
			created: now - (index + 1) * minute,
			readyState: "BUILDING",
			target: null,
			projectId: "prj_web",
		}))
		const fake = makeFake(many)
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.deployments = [{ ...many[0], readyState: "READY" }]
				yield* poll()
				const deployments = yield* VercelIntegrationService.use((vercel) =>
					vercel.deployments(orgId, "prj_web", 50),
				)
				assert.strictEqual(deployments.length, 50)
				assert.strictEqual(deployments[0]?.id, "dpl_0")
				assert.strictEqual(deployments[0]?.state, "READY")
				assert.strictEqual(deployments.at(-1)?.id, "dpl_49")
				const count = yield* Effect.promise(() =>
					queryFirstRow<{ count: number }>(
						testDb,
						"SELECT count(*)::int AS count FROM vercel_deployments WHERE org_id = $1",
						[orgId],
					),
				)
				assert.strictEqual(count?.count, 50)
			}),
		)
	})

	it.effect(
		"a build's start, end and failure are stored and updated when a later poll sees it fail",
		() => {
			const testDb = createTestDb(trackedDbs)
			const building = {
				uid: "dpl_f",
				created: now - 10 * minute,
				buildingAt: now - 9 * minute,
				readyState: "BUILDING",
				target: "production",
				projectId: "prj_web",
			}
			const fake = makeFake([building])
			const latest = () =>
				VercelIntegrationService.use((vercel) => vercel.deployments(orgId, "prj_web", 1)).pipe(
					Effect.map((deployments) => deployments[0]),
				)
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					const started = yield* latest()
					assert.strictEqual(started?.state, "BUILDING")
					assert.strictEqual(started?.buildingAt, building.buildingAt)
					assert.isNull(started?.readyAt)
					assert.isNull(started?.errorCode)
					const failed = {
						...building,
						readyState: "ERROR",
						ready: now - 4 * minute,
						errorCode: "BUILD_FAILED",
						errorMessage: 'Command "next build" exited with 1',
					}
					fake.deployments = [failed]
					yield* poll()
					const ended = yield* latest()
					assert.strictEqual(ended?.state, "ERROR")
					assert.strictEqual(ended?.buildingAt, failed.buildingAt)
					assert.strictEqual(ended?.readyAt, failed.ready)
					assert.strictEqual(ended?.errorCode, failed.errorCode)
					assert.strictEqual(ended?.errorMessage, failed.errorMessage)
				}),
			)
		},
	)

	it.effect("deployments without a project are the whole team's, newest first", () => {
		const testDb = createTestDb(trackedDbs)
		const deployment = (uid: string, projectId: string, minutesAgo: number) => ({
			uid,
			created: now - minutesAgo * minute,
			readyState: "READY",
			target: null,
			projectId,
		})
		const fake = makeFake([
			deployment("dpl_web_old", "prj_web", 30),
			deployment("dpl_api_new", "prj_api", 5),
			deployment("dpl_web_new", "prj_web", 10),
			deployment("dpl_api_old", "prj_api", 40),
		])
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const deployments = yield* VercelIntegrationService.use((vercel) =>
					vercel.deployments(orgId, undefined, 3),
				)
				assert.deepStrictEqual(
					Arr.map(deployments, (d) => [d.id, d.projectId]),
					[
						["dpl_api_new", "prj_api"],
						["dpl_web_new", "prj_web"],
						["dpl_web_old", "prj_web"],
					],
				)
			}),
		)
	})

	it.effect("a deployment listed twice across pages is stored once and the watermark moves on", () => {
		const testDb = createTestDb(trackedDbs)
		const deployment = {
			uid: "dpl_9",
			created: now - 5 * minute,
			readyState: "READY",
			target: "production",
			projectId: "prj_web",
		}
		const fake = makeFake([deployment, deployment])
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const connected = yield* connect()
				assert.isNull(connected.lastError)
				assert.strictEqual(connected.projects[0]?.latestDeployment?.id, "dpl_9")
				const row = yield* Effect.promise(() =>
					queryFirstRow<{ watermark: number }>(
						testDb,
						"SELECT extract(epoch FROM deployments_watermark_at)::float8 * 1000 AS watermark FROM vercel_connections WHERE org_id = $1",
						[orgId],
					),
				)
				assert.strictEqual(row?.watermark, deployment.created)
			}),
		)
	})

	it.effect("reconnecting to another team deletes the old team's drains with the old token", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.teams = [
			{ id: "team_1", slug: "acme", name: "Acme" },
			{ id: "team_2", slug: "beta", name: "Beta" },
		]
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				// The old team's trace drain cannot be deleted: the new connection still stands.
				fake.respond = (call) =>
					call.method === "DELETE" && call.path === "/v1/drains/drn_2"
						? vercelError(500, "internal")
						: undefined
				const reconnected = yield* VendorFake.elapsing(
					connect({ token: "vc_token_456", teamId: "team_2" }),
				)
				assert.deepStrictEqual(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => [
						call.path,
						call.teamId,
						call.authorization,
					]),
					[
						["/v1/drains/drn_1", "team_1", "Bearer vc_token_123"],
						// The failing delete is retried twice, with the same old token.
						["/v1/drains/drn_2", "team_1", "Bearer vc_token_123"],
						["/v1/drains/drn_2", "team_1", "Bearer vc_token_123"],
						["/v1/drains/drn_2", "team_1", "Bearer vc_token_123"],
						["/v1/drains/drn_3", "team_1", "Bearer vc_token_123"],
					],
				)
				assert.strictEqual(reconnected.team?.id, "team_2")
				assert.include(reconnected.lastError ?? "", "previous team (acme)")
				assert.deepStrictEqual(
					[
						reconnected.drains.logs?.id,
						reconnected.drains.traces?.id,
						reconnected.drains.aiGateway?.id,
					],
					["drn_4", "drn_5", "drn_6"],
				)
				assert.deepStrictEqual(drainsTo(fake, TRACES_ENDPOINT, "team_2"), ["drn_5"])
			}),
		)
	})

	it.effect(
		"a cost source stays through a reconnect of its team, and goes with the team or the connection",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			fake.teams = [
				{ id: "team_1", slug: "acme", name: "Acme" },
				{ id: "team_2", slug: "beta", name: "Beta" },
			]
			/** The org adds its connected team as a cost source, the way the Cost page does. */
			const addCostSource = Effect.promise(() =>
				testDb.pglite.query(
					`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, created_at, updated_at)
				 SELECT gen_random_uuid()::text, org_id, 'vercel', id, team_id, now(), now() FROM vercel_connections`,
				),
			)
			const held = Effect.promise(() =>
				queryFirstRow<{
					error: string | null
					reason: string | null
					held: boolean
					failures: number
					leased: boolean
					synced: boolean
				}>(
					testDb,
					`SELECT last_error AS error, last_error_reason AS reason, next_attempt_at IS NOT NULL AS held,
					        consecutive_failures AS failures, lease_until IS NOT NULL AS leased,
					        last_synced_at IS NOT NULL AS synced
					   FROM cost_sources WHERE provider = 'vercel'`,
				),
			)
			const costSources = Effect.promise(() =>
				testDb.pglite.query<{ account: string }>(
					"SELECT account_id AS account FROM cost_sources WHERE provider = 'vercel'",
				),
			).pipe(Effect.map((result) => Arr.map(result.rows, (row) => row.account)))
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					yield* addCostSource
					// The source is held for the old token's failure, with a pull on it still in flight.
					yield* Effect.promise(() =>
						testDb.pglite.query(
							`UPDATE cost_sources SET last_error = 'Vercel rejected the saved token.',
							        last_error_reason = 'auth', next_attempt_at = now() + interval '6 hours',
							        consecutive_failures = 3, lease_until = now() + interval '20 minutes',
							        watermark_date = '2026-10-18', last_synced_at = now()`,
						),
					)
					// The team renamed its slug at Vercel since: the connection learns it on the reconnect.
					fake.teams = [
						{ id: "team_1", slug: "acme-labs", name: "Acme" },
						{ id: "team_2", slug: "beta", name: "Beta" },
					]
					// A new token for the same team: the source and its history stay, and its account is the
					// team's id, which the rename leaves alone, so stored rows and new ones stay one account.
					yield* connect({ token: "vc_token_456" })
					assert.deepStrictEqual(yield* costSources, ["team_1"])
					// It is due at the next tick: no hold, no claim, and no last sync to wait a day from.
					assert.deepStrictEqual(yield* held, {
						error: null,
						reason: null,
						held: false,
						failures: 0,
						leased: false,
						synced: false,
					})
					// Another team: its spend would overwrite the days the source holds.
					yield* connect({ token: "vc_token_789", teamId: "team_2" })
					assert.deepStrictEqual(yield* costSources, [])

					yield* addCostSource
					assert.deepStrictEqual(yield* costSources, ["team_2"])
					yield* disconnect()
					assert.deepStrictEqual(yield* costSources, [])
				}),
			)
		},
	)

	it.effect(
		"a reconnect decides from the team the connection has when it writes, not from an earlier read",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			fake.teams = [
				{ id: "team_1", slug: "acme", name: "Acme" },
				{ id: "team_2", slug: "beta", name: "Beta" },
			]
			const costSources = Effect.promise(() =>
				testDb.pglite.query<{ account: string }>(
					"SELECT account_id AS account FROM cost_sources WHERE provider = 'vercel'",
				),
			).pipe(Effect.map((result) => Arr.map(result.rows, (row) => row.account)))
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					// This reconnect read team_1 as the connection's team. While it removes the old
					// team's drains, another request commits the move to team_2 and adds its cost source.
					let moved = false
					fake.respond = (call) => {
						if (moved || call.method !== "GET" || call.path !== "/v1/drains") return undefined
						moved = true
						return testDb.pglite
							.query("UPDATE vercel_connections SET team_id = 'team_2', team_slug = 'beta'")
							.then(() =>
								testDb.pglite.query(
									`INSERT INTO cost_sources (id, org_id, provider, connection_ref, account_id, created_at, updated_at)
									 SELECT gen_random_uuid()::text, org_id, 'vercel', id, 'team_2', now(), now() FROM vercel_connections`,
								),
							)
							.then(() => json({ drains: [] }))
					}
					const reconnected = yield* connect({ token: "vc_token_456", teamId: "team_2" })
					assert.isTrue(moved)
					assert.strictEqual(reconnected.team?.id, "team_2")
					// The connection was on team_2 already when this write ran: its source is that
					// team's and stays. Decided from the earlier read, it would have been deleted.
					assert.deepStrictEqual(yield* costSources, ["team_2"])
				}),
			)
		},
	)

	it.effect("a first connect Vercel refuses deletes the drains it made and stays disconnected", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.respond = (call) => (isTraceCreate(call) ? vercelError(500, "internal") : undefined)
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip(connect())
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
				assert.deepStrictEqual(
					Arr.map(callsTo(fake, "DELETE", "/v1/drains"), (call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2"],
				)
				assert.strictEqual(fake.drains.size, 0)
				assert.isFalse((yield* status()).connected)
			}),
		)
	})

	it.effect("discover reports each team's Vercel plan", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.teams = [
			{ id: "team_1", slug: "acme", name: "Acme", billing: { plan: "hobby" } },
			{ id: "team_2", slug: "labs", name: "Labs" },
		]
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const found = yield* VercelIntegrationService.use((vercel) =>
					vercel.discover("vercel_token_123", undefined),
				)
				assert.deepStrictEqual(
					Arr.map(found.teams, (team) => [team.slug, team.plan]),
					[
						["acme", "hobby"],
						["labs", null],
					],
				)
			}),
		)
	})

	it.effect("a connect Vercel refuses for the plan says to upgrade the team", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.respond = (call) =>
			call.method === "POST" && call.path === "/v1/drains"
				? vercelError(403, "Drains are not available for team 'team_1'")
				: undefined
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip(connect())
				assert.strictEqual(
					error.message,
					"Vercel creates drains only on Pro and Enterprise teams. Upgrade Acme in Vercel's team settings, then connect again. (Vercel: Drains are not available for team 'team_1')",
				)
			}),
		)
	})

	it.effect("a drain Vercel cannot deliver to names Maple's ingest endpoint", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.respond = (call) =>
			call.method === "POST" && call.path === "/v1/drains"
				? vercelError(400, "Invalid delivery endpoint")
				: undefined
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const error = yield* Effect.flip(connect())
				assert.include(
					error.message,
					"Vercel could not reach Maple's ingest endpoint at https://ingest.test",
				)
				assert.include(error.message, "(Vercel: Invalid delivery endpoint)")
			}),
		)
	})
})
