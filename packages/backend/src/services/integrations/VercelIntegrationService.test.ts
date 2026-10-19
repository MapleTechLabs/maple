import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Fiber, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { OrgId, UserId, VercelConnectRequest } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
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
}

interface FakeDrain {
	readonly id: string
	readonly teamId: string
	readonly createdAt: number
	status: string
	/** The create body with every PATCH merged in. */
	body: Readonly<Record<string, unknown>>
}

/** A fake Vercel account: its teams, one project, its deployments, and the drains on its teams. */
interface Fake {
	readonly calls: Array<VercelCall>
	readonly drains: Map<string, FakeDrain>
	mode: "ok" | "token_rejected"
	teams: ReadonlyArray<{ readonly id: string; readonly slug: string; readonly name: string }>
	deployments: ReadonlyArray<Deployment>
	created: number
	/** Answers a call before the default handling when it returns a response. */
	respond: (call: VercelCall, signal: AbortSignal | null | undefined) => Response | Promise<Response> | undefined
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
		...(Array.isArray(projectIds) ? { projectIds } : undefined),
		delivery: { ...asObject(delivery), headers: {} },
	}
}

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const fakeFetch = (fake: Fake): typeof fetch =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
		)
		const method = init?.method ?? "GET"
		const text = await new Response(init?.body ?? null).text()
		const call: VercelCall = {
			method,
			path: url.pathname,
			teamId: url.searchParams.get("teamId"),
			body: text === "" ? null : decodeJson(text),
			authorization: new Headers(init?.headers).get("authorization"),
		}
		fake.calls.push(call)
		const response = await fake.respond(call, init?.signal)
		if (response !== undefined) return response
		if (fake.mode === "token_rejected") {
			return json({ error: { code: "forbidden", message: "Not authorized" } }, 403)
		}
		if (url.pathname === "/v2/teams") return json({ teams: fake.teams, pagination: { next: null } })
		if (url.pathname === "/v10/projects") {
			return json({
				projects: [
					{
						id: "prj_web",
						name: "web",
						framework: "nextjs",
						targets: { production: { id: "dpl_1" } },
					},
				],
				pagination: { next: null },
			})
		}
		if (url.pathname === "/v6/deployments") {
			return json({
				deployments: fake.deployments.map((d) => ({
					...d,
					url: `${d.uid}.vercel.app`,
					meta: { githubCommitSha: `sha_${d.uid}`, githubCommitRef: "main" },
					creator: { username: "dev" },
				})),
				pagination: { next: null },
			})
		}
		const teamId = call.teamId ?? ""
		const drainId = url.pathname.split("/")[3]
		if (drainId === undefined) {
			if (method === "POST") {
				const drain = addDrain(fake, teamId, call.body)
				return json({ id: drain.id, status: drain.status })
			}
			return json({
				drains: [...fake.drains.values()].filter((d) => d.teamId === teamId).map(listed),
			})
		}
		const drain = fake.drains.get(drainId)
		if (drain === undefined || drain.teamId !== teamId) {
			return json({ error: { code: "not_found", message: "Drain not found" } }, 404)
		}
		if (method === "DELETE") {
			fake.drains.delete(drainId)
			return new Response(null, { status: 204 })
		}
		if (method === "PATCH") {
			const patch = asObject(call.body)
			drain.body = { ...drain.body, ...patch }
			if (typeof patch.status === "string") drain.status = patch.status
		}
		return json({ id: drain.id, status: drain.status })
	}) as typeof fetch

const makeLayer = (testDb: TestDb, stub: typeof fetch) =>
	Layer.effect(VercelIntegrationService, VercelIntegrationService.make).pipe(
		Layer.provideMerge(Layer.mergeAll(FetchHttpClient.layer, OrgIngestKeysService.layer)),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub)),
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
	}).pipe(Effect.provide(makeLayer(testDb, fakeFetch(fake))))

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
	fake.calls.filter((call) => call.method === method && call.path.startsWith(path))

/** Ids of the drains on `teamId` that deliver to `endpoint`, oldest first. */
const drainsTo = (fake: Fake, endpoint: string, teamId = "team_1") =>
	[...fake.drains.values()]
		.filter((drain) => drain.teamId === teamId && JSON.stringify(drain.body).includes(endpoint))
		.map((drain) => drain.id)

const isTraceCreate = (call: VercelCall) =>
	call.method === "POST" && call.path === "/v1/drains" && JSON.stringify(call.body).includes("Maple traces")

const vercelError = (status: number, message: string) => json({ error: { message } }, status)

const poll = () => VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId))
const status = () => VercelIntegrationService.use((vercel) => vercel.getStatus(orgId))
const disconnect = () => VercelIntegrationService.use((vercel) => vercel.disconnect(orgId))

describe("VercelIntegrationService", () => {
	it.effect("connect creates a log drain and a trace drain carrying the org's private ingest key", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const connected = yield* connect()
				const keys = yield* OrgIngestKeysService.use((service) => service.getOrCreate(orgId, userId))
				const headers = { authorization: `Bearer ${keys.privateKey}` }
				const created = callsTo(fake, "POST", "/v1/drains").map((call) => call.body)
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
				])
				assert.isTrue(fake.calls.every((call) => call.authorization === "Bearer vc_token_123"))
				assert.deepStrictEqual({ ...connected.team }, { id: "team_1", slug: "acme", name: "Acme" })
				assert.deepStrictEqual(
					{ ...connected.drains.logs },
					{ id: "drn_1", status: "enabled", lastError: null },
				)
				assert.deepStrictEqual(
					{ ...connected.drains.traces },
					{ id: "drn_2", status: "enabled", lastError: null },
				)
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
	})

	it.effect("connect leaves sampling out at a rate of 1 and fails on a token Vercel rejects", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect({ samplingRate: 1, tracesEnabled: false, projectScope: "all", projectIds: [] })
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
					vercel.updateSettings(orgId, { logsEnabled: false, samplingRate: 1 }),
				)
				assert.deepStrictEqual(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1"],
				)
				const patched = callsTo(fake, "PATCH", "/v1/drains")
				assert.deepStrictEqual(
					patched.map((call) => call.path),
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
				const otherEndpoint = addDrain(fake, "team_1", traceDrainBody("https://collector.example/v1/traces"))
				const summary = yield* poll()
				assert.strictEqual(summary.drainsRepaired, 2)
				assert.sameMembers(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					[`/v1/drains/${extraLogs.id}`, `/v1/drains/${extraTraces.id}`],
				)
				assert.sameMembers([...fake.drains.keys()], ["drn_1", "drn_2", otherOrg.id, otherEndpoint.id])
				const after = yield* status()
				assert.deepStrictEqual([after.drains.logs?.id, after.drains.traces?.id], ["drn_1", "drn_2"])
			}),
		)
	})

	it.effect("a poll patches a drain edited on Vercel back to the settings and leaves a disabled one off", () => {
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
					patched.map((call) => call.path),
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

				yield* VercelIntegrationService.use((vercel) => vercel.updateSettings(orgId, {}))
				assert.deepInclude(callsTo(fake, "PATCH", "/v1/drains/drn_2")[0]?.body, { status: "enabled" })
				assert.strictEqual((yield* status()).drains.traces?.status, "enabled")
			}),
		)
	})

	it.effect("a picked project deleted on Vercel is dropped from the settings instead of patched every poll", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect({ projectIds: ["prj_web", "prj_gone"] })
				// Vercel drops a deleted project from every drain that named it.
				for (const drain of fake.drains.values()) drain.body = { ...drain.body, projectIds: ["prj_web"] }
				yield* TestClock.adjust("61 minutes")
				yield* poll()
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 0)
				assert.deepStrictEqual((yield* status()).projectIds, ["prj_web"])
			}),
		)
	})

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
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 2)
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
				assert.deepStrictEqual({ ...after.drains.traces }, { id: "drn_3", status: "enabled", lastError: null })
				assert.strictEqual(after.drains.logs?.id, "drn_1")
			}),
		)
	})

	it.effect("a connect cut off after creating a drain is finished by the next poll without a second drain", () => {
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
			return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason)))
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
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 2)
				assert.deepStrictEqual(drainsTo(fake, TRACES_ENDPOINT), ["drn_2"])
				const after = yield* status()
				assert.deepStrictEqual([after.drains.logs?.id, after.drains.traces?.id], ["drn_1", "drn_2"])
			}),
		)
	})

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
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 4)
				yield* poll()
				const logs = drainsTo(fake, LOGS_ENDPOINT)
				const traces = drainsTo(fake, TRACES_ENDPOINT)
				assert.strictEqual(logs.length, 1)
				assert.strictEqual(traces.length, 1)
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
					call.method === "DELETE" && call.path === "/v1/drains/drn_2" ? vercelError(410, "Gone") : undefined
				const result = yield* disconnect()
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: true })
				assert.sameMembers(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2", `/v1/drains/${duplicate.id}`],
				)
				assert.isTrue(fake.drains.has(otherOrg.id))
				const after = yield* status()
				assert.isFalse(after.connected)
				assert.deepStrictEqual(after.projects, [])
			}),
		)
	})

	it.effect("disconnect still deletes the trace drain and the rows when the log drain delete fails", () => {
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
				const result = yield* disconnect()
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: false })
				assert.deepStrictEqual(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2"],
				)
				assert.isFalse((yield* status()).connected)
			}),
		)
	})

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
				// The poll saw no drains and created two, then took them back.
				assert.strictEqual(callsTo(fake, "POST", "/v1/drains").length, 4)
				assert.strictEqual(fake.drains.size, 0)
			}),
		)
	})

	it.effect("a poll after the private ingest key rolled rewrites both drains with the new key", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				const rolled = yield* OrgIngestKeysService.use((keys) => keys.rerollPrivate(orgId, userId))
				const summary = yield* poll()
				assert.strictEqual(summary.drainsRepaired, 2)
				const patched = callsTo(fake, "PATCH", "/v1/drains")
				assert.deepStrictEqual(
					patched.map((call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2"],
				)
				for (const call of patched) {
					assert.deepInclude(call.body, {
						delivery: {
							...(call.path.endsWith("drn_1")
								? {
										type: "http",
										endpoint: LOGS_ENDPOINT,
										encoding: "ndjson",
										compression: "none",
									}
								: {
										type: "otlphttp",
										endpoint: { traces: TRACES_ENDPOINT },
										encoding: "proto",
									}),
							headers: { authorization: `Bearer ${rolled.privateKey}` },
						},
					})
				}
				// Re-keyed once: the next poll only reads the drains.
				yield* poll()
				assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 2)
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
				assert.strictEqual(retried.drainsRepaired, 2)
				assert.deepStrictEqual(
					callsTo(fake, "PATCH", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2", "/v1/drains/drn_1", "/v1/drains/drn_2"],
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
				const all = yield* VercelIntegrationService.use((vercel) => vercel.pollAllOrgs())
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
					call.path === "/v6/deployments" ? vercelError(429, "Too many requests") : undefined
				const limited = yield* poll()
				assert.strictEqual(limited.skipped, "rate_limited")
				assert.include((yield* status()).lastError ?? "", "429")
				fake.respond = () => undefined
				yield* VercelIntegrationService.use((vercel) => vercel.updateSettings(orgId, { samplingRate: 1 }))
				assert.strictEqual((yield* poll()).skipped, "lease held")
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
				fake.deployments = [{ ...many[0]!, readyState: "READY" }]
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
					call.method === "DELETE" && call.path === "/v1/drains/drn_2" ? vercelError(500, "internal") : undefined
				const reconnected = yield* connect({ token: "vc_token_456", teamId: "team_2" })
				assert.deepStrictEqual(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => [call.path, call.teamId, call.authorization]),
					[
						["/v1/drains/drn_1", "team_1", "Bearer vc_token_123"],
						["/v1/drains/drn_2", "team_1", "Bearer vc_token_123"],
					],
				)
				assert.strictEqual(reconnected.team?.id, "team_2")
				assert.include(reconnected.lastError ?? "", "previous team (acme)")
				assert.deepStrictEqual([reconnected.drains.logs?.id, reconnected.drains.traces?.id], ["drn_3", "drn_4"])
				assert.deepStrictEqual(drainsTo(fake, TRACES_ENDPOINT, "team_2"), ["drn_4"])
			}),
		)
	})

	it.effect("a first connect Vercel refuses deletes the drain it made and stays disconnected", () => {
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
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1"],
				)
				assert.strictEqual(fake.drains.size, 0)
				assert.isFalse((yield* status()).connected)
			}),
		)
	})
})
