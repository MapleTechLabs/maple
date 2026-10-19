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

/** A fake Vercel account: its teams, one project, its deployments, and the drains created on it. */
interface Fake {
	readonly calls: Array<VercelCall>
	/** Drain ids Vercel answers 404 for; a deleted drain joins them. */
	readonly missingDrains: Set<string>
	mode: "ok" | "token_rejected"
	teams: ReadonlyArray<{ readonly id: string; readonly slug: string; readonly name: string }>
	deployments: ReadonlyArray<Deployment>
	drainsCreated: number
	/** Answers a call before the default handling when it returns a response. */
	respond: (call: VercelCall) => Response | Promise<Response> | undefined
}

const makeFake = (deployments?: ReadonlyArray<Deployment>): Fake => ({
	calls: [],
	missingDrains: new Set(),
	mode: "ok",
	teams: [{ id: "team_1", slug: "acme", name: "Acme" }],
	drainsCreated: 0,
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

const decodeJson = Schema.decodeUnknownSync(Schema.UnknownFromJsonString)

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
		const response = await fake.respond(call)
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
		const drainId = url.pathname.split("/")[3]
		if (drainId === undefined && method === "POST") {
			fake.drainsCreated++
			return json({ id: `drn_${fake.drainsCreated}`, status: "enabled" })
		}
		if (drainId !== undefined && fake.missingDrains.has(drainId)) {
			return json({ error: { code: "not_found", message: "Drain not found" } }, 404)
		}
		if (method === "DELETE" && drainId !== undefined) {
			fake.missingDrains.add(drainId)
			return new Response(null, { status: 204 })
		}
		return json({ id: drainId, status: "enabled" })
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

const orgId = asOrgId("org_vercel")
const userId = asUserId("user_1")

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

const vercelError = (status: number, message: string) => json({ error: { message } }, status)

const poll = () => VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId))
const status = () => VercelIntegrationService.use((vercel) => vercel.getStatus(orgId))

describe("VercelIntegrationService", () => {
	it.effect("connect creates a log drain and a trace drain carrying the org's private ingest key", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				const status = yield* connect()
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
							endpoint: "https://ingest.test/v1/logpush/vercel",
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
							endpoint: { traces: "https://ingest.test/v1/traces" },
							encoding: "proto",
							headers,
						},
						sampling: [{ type: "head_sampling", rate: 0.5 }],
					},
				])
				assert.isTrue(fake.calls.every((call) => call.authorization === "Bearer vc_token_123"))
				assert.deepStrictEqual({ ...status.team }, { id: "team_1", slug: "acme", name: "Acme" })
				assert.deepStrictEqual(
					{ ...status.drains.logs },
					{ id: "drn_1", status: "enabled", lastError: null },
				)
				assert.deepStrictEqual(
					{ ...status.drains.traces },
					{ id: "drn_2", status: "enabled", lastError: null },
				)
				// The first sync ran inline: the project carries its production and latest deployment.
				const project = status.projects[0]
				assert.strictEqual(project?.forwarded, true)
				assert.strictEqual(project?.productionDeployment?.id, "dpl_1")
				assert.strictEqual(project?.latestDeployment?.id, "dpl_2")
				assert.strictEqual(project?.latestDeployment?.commitSha, "sha_dpl_2")
				assert.isNotNull(status.lastSuccessAt)
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
				const status = yield* VercelIntegrationService.use((vercel) =>
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
				assert.isNull(status.drains.logs)
				assert.strictEqual(status.drains.traces?.id, "drn_2")
				assert.isFalse(status.logsEnabled)
			}),
		)
	})

	it.effect("disconnect counts a drain Vercel already deleted as removed", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.missingDrains.add("drn_1")
				const result = yield* VercelIntegrationService.use((vercel) => vercel.disconnect(orgId))
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: true })
				assert.strictEqual(callsTo(fake, "DELETE", "/v1/drains").length, 2)
				const status = yield* VercelIntegrationService.use((vercel) => vercel.getStatus(orgId))
				assert.isFalse(status.connected)
				assert.deepStrictEqual(status.projects, [])
			}),
		)
	})

	it.effect("a poll after the private ingest key rolled rewrites both drains with the new key", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return Effect.gen(function* () {
			yield* run(testDb, fake, connect())
			const rolled = yield* run(
				testDb,
				fake,
				OrgIngestKeysService.use((keys) => keys.rerollPrivate(orgId, userId)),
			)
			const summary = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId)),
			)
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
									endpoint: "https://ingest.test/v1/logpush/vercel",
									encoding: "ndjson",
									compression: "none",
								}
							: {
									type: "otlphttp",
									endpoint: { traces: "https://ingest.test/v1/traces" },
									encoding: "proto",
								}),
						headers: { authorization: `Bearer ${rolled.privateKey}` },
					},
				})
			}
			// Re-keyed once: the next poll only reads the drains.
			yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId)),
			)
			assert.strictEqual(callsTo(fake, "PATCH", "/v1/drains").length, 2)
		})
	})

	it.effect("a poll re-creates a drain that was deleted on Vercel", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return Effect.gen(function* () {
			yield* run(testDb, fake, connect())
			fake.missingDrains.add("drn_2")
			const summary = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId)),
			)
			assert.strictEqual(summary.drainsRepaired, 1)
			const status = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.getStatus(orgId)),
			)
			assert.deepStrictEqual(
				{ ...status.drains.traces },
				{ id: "drn_3", status: "enabled", lastError: null },
			)
			assert.strictEqual(status.drains.logs?.id, "drn_1")
		})
	})

	it.effect("a token rejected while polling pauses the connection", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return Effect.gen(function* () {
			yield* run(testDb, fake, connect())
			fake.mode = "token_rejected"
			yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId)),
			)
			const status = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.getStatus(orgId)),
			)
			assert.isTrue(status.authFailed)
			const all = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollAllOrgs()),
			)
			assert.strictEqual(all.orgs, 0)
		})
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
		return Effect.gen(function* () {
			yield* run(testDb, fake, connect())
			fake.deployments = [{ ...many[0]!, readyState: "READY" }]
			yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.pollOrg(orgId)),
			)
			const deployments = yield* run(
				testDb,
				fake,
				VercelIntegrationService.use((vercel) => vercel.deployments(orgId, "prj_web", 50)),
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
		})
	})

	it.effect(
		"reconnecting to another team deletes the old team's drains after the new connection is saved",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			fake.teams = [
				{ id: "team_1", slug: "acme", name: "Acme" },
				{ id: "team_2", slug: "beta", name: "Beta" },
			]
			const savedTeamAtDelete: Array<string | undefined> = []
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					fake.respond = async (call) => {
						if (call.method !== "DELETE") return undefined
						const row = await queryFirstRow<{ team_id: string }>(
							testDb,
							"SELECT team_id FROM vercel_connections WHERE org_id = $1",
							[orgId],
						)
						savedTeamAtDelete.push(row?.team_id)
						// The old team's trace drain cannot be deleted: the new connection still stands.
						return call.path.endsWith("drn_2") ? vercelError(500, "internal") : undefined
					}
					const reconnected = yield* connect({ token: "vc_token_456", teamId: "team_2" })
					assert.deepStrictEqual(
						callsTo(fake, "DELETE", "/v1/drains").map((call) => [
							call.path,
							call.teamId,
							call.authorization,
						]),
						[
							["/v1/drains/drn_1", "team_1", "Bearer vc_token_123"],
							["/v1/drains/drn_2", "team_1", "Bearer vc_token_123"],
						],
					)
					assert.deepStrictEqual(savedTeamAtDelete, ["team_2", "team_2"])
					assert.strictEqual(reconnected.team?.id, "team_2")
					assert.deepStrictEqual(
						[reconnected.drains.logs?.id, reconnected.drains.traces?.id],
						["drn_3", "drn_4"],
					)
				}),
			)
		},
	)

	it.effect("a failed trace drain create deletes the log drain the same connect just created", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		fake.respond = (call) =>
			call.method === "POST" &&
			call.path === "/v1/drains" &&
			JSON.stringify(call.body).includes("Maple traces")
				? vercelError(500, "internal")
				: undefined
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
				assert.isFalse((yield* status()).connected)
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
				fake.respond = (call) =>
					call.method === "GET" && call.path === "/v1/drains/drn_1"
						? vercelError(403, "Drains are not available on the Hobby plan")
						: undefined
				const summary = yield* poll()
				assert.strictEqual(summary.failures, 1)
				const after = yield* status()
				assert.isFalse(after.authFailed)
				assert.include(after.lastError ?? "", "Hobby plan")
				assert.include(after.drains.logs?.lastError ?? "", "Hobby plan")
				assert.strictEqual(after.drains.traces?.status, "enabled")
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

	it.effect("a 429 holds the org off polling and shows as its last error", () => {
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
				assert.strictEqual((yield* poll()).skipped, "lease held")
			}),
		)
	})

	it.effect("disconnect still deletes the trace drain when the log drain delete fails", () => {
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
				const result = yield* VercelIntegrationService.use((vercel) => vercel.disconnect(orgId))
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: false })
				assert.deepStrictEqual(
					callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
					["/v1/drains/drn_1", "/v1/drains/drn_2"],
				)
				assert.isFalse((yield* status()).connected)
			}),
		)
	})

	it.effect("disconnect counts a drain Vercel answers 410 Gone for as removed", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = makeFake()
		return run(
			testDb,
			fake,
			Effect.gen(function* () {
				yield* connect()
				fake.respond = (call) =>
					call.method === "DELETE" && call.path === "/v1/drains/drn_2"
						? vercelError(410, "Gone")
						: undefined
				const result = yield* VercelIntegrationService.use((vercel) => vercel.disconnect(orgId))
				assert.deepStrictEqual(result, { disconnected: true, drainsRemoved: true })
			}),
		)
	})

	it.effect(
		"a poll racing a settings change neither overwrites its drains nor leaves a drain behind",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = makeFake()
			let reached = (): void => undefined
			const pollReachedDrain = new Promise<void>((resolve) => {
				reached = resolve
			})
			let release = (): void => undefined
			const settingsSaved = new Promise<void>((resolve) => {
				release = resolve
			})
			return run(
				testDb,
				fake,
				Effect.gen(function* () {
					yield* connect()
					// The poll checks the log drain, stalls, and reads it as deleted once the settings ran.
					fake.respond = async (call) => {
						if (call.method !== "GET" || call.path !== "/v1/drains/drn_1") return undefined
						reached()
						await settingsSaved
						return undefined
					}
					const polling = yield* Effect.forkChild(poll())
					yield* Effect.promise(() => pollReachedDrain)
					const updated = yield* VercelIntegrationService.use((vercel) =>
						vercel.updateSettings(orgId, { logsEnabled: false }),
					)
					assert.isNull(updated.drains.logs)
					release()
					const summary = yield* Fiber.join(polling)
					assert.strictEqual(summary.skipped, "lease lost")
					const after = yield* status()
					assert.isNull(after.drains.logs)
					assert.strictEqual(after.drains.traces?.id, "drn_2")
					// The drain the stale poll re-created is deleted again.
					assert.deepStrictEqual(
						callsTo(fake, "DELETE", "/v1/drains").map((call) => call.path),
						["/v1/drains/drn_1", "/v1/drains/drn_3"],
					)
					// The lease is free again: the next poll runs.
					assert.isNull((yield* poll()).skipped)
				}),
			)
		},
	)
})
