import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { OrgId } from "@maple/domain/primitives"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { GcpLiveMetricsService } from "./GcpLiveMetricsService"

const now = Date.UTC(2026, 9, 15, 12, 0, 0)
const ORG = Schema.decodeSync(OrgId)("org_gcp")
const OTHER_ORG = "org_other"
const TENANT = { orgId: ORG }

// Connector ids and the reader account each one's setup script creates.
const PROJECT_CONNECTOR = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const FOLDER_CONNECTOR = "028f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const OTHER_CONNECTOR = "038f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const readerOf = (connectorId: string, hostProject: string) =>
	`maple-${connectorId.replaceAll("-", "").slice(0, 24)}@${hostProject}.iam.gserviceaccount.com`
const PROJECT_READER = readerOf(PROJECT_CONNECTOR, "acme-prod")
const FOLDER_READER = readerOf(FOLDER_CONNECTOR, "acme-host")

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
	encodedKey = Buffer.from(
		JSON.stringify({
			private_key_id: "key-1",
			private_key: `-----BEGIN PRIVATE KEY-----\n${body.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`,
			client_email: "collector@maple-prod.iam.gserviceaccount.com",
		}),
	).toString("base64")
})

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

const denied = () => json({ error: { code: 403, status: "PERMISSION_DENIED", message: "denied" } }, 403)

const googleError = (status: number, code: string, reason?: string) =>
	json(
		{
			error: {
				code: status,
				status: code,
				message: "refused",
				...(reason === undefined
					? undefined
					: { details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason }] }),
			},
		},
		status,
	)

interface PromQlCall {
	readonly project: string
	/** `query` or `query_range`. */
	readonly path: string
	readonly params: Record<string, string>
	/** The reader account whose token made the call. */
	readonly reader: string
	readonly quotaProject: string | null
}

interface Calls {
	oauth: number
	readonly impersonate: Array<string>
	readonly promql: Array<PromQlCall>
	/** `project pageToken` per descriptor page read. */
	readonly descriptors: Array<string>
	readonly assets: Array<string>
	readonly scopes: Array<string>
}

interface StubOptions {
	readonly impersonate?: (account: string) => Response | undefined
	readonly promql?: (call: PromQlCall) => Response | undefined
	/** Projects under `folders/123`, as `[projectId, state]`. */
	readonly folderProjects?: ReadonlyArray<readonly [string, string]>
	readonly assets?: () => Response | undefined
	/** A project's active descriptors, by page token (`""` for the first page). */
	readonly descriptors?: (project: string, pageToken: string) => Response | undefined
	/** Projects a project's metrics scope reads besides itself. */
	readonly scopes?: Record<string, ReadonlyArray<string>>
}

/** A stand-in project number: Google names a metrics scope's projects by number. */
const numberOf = (projectId: string) =>
	String([...projectId].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 1_000_000_007, 7))

const matrix = (
	...result: ReadonlyArray<{ metric: Record<string, string>; values: Array<[number, string]> }>
) => json({ status: "success", data: { resultType: "matrix", result } })

const stubFetch = (calls: Calls, options: StubOptions = {}) =>
	(async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(
			typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
		)
		const headers = new Headers(init?.headers)
		const reader = (headers.get("authorization") ?? "").replace("Bearer reader:", "")
		if (url.host === "oauth2.googleapis.com") {
			calls.oauth += 1
			return json({ access_token: "ya29.maple", expires_in: 600 })
		}
		if (url.host === "iamcredentials.googleapis.com") {
			const account = decodeURIComponent(
				url.pathname
					.replace("/v1/projects/-/serviceAccounts/", "")
					.replace(":generateAccessToken", ""),
			)
			calls.impersonate.push(account)
			return options.impersonate?.(account) ?? json({ accessToken: `reader:${account}` })
		}
		if (url.host === "cloudasset.googleapis.com") {
			calls.assets.push(`${url.pathname} ${url.searchParams.get("assetTypes")}`)
			return (
				options.assets?.() ??
				json({
					results: (options.folderProjects ?? []).map(([projectId, state]) => ({
						name: `//cloudresourcemanager.googleapis.com/projects/${projectId.length}0001`,
						assetType: "cloudresourcemanager.googleapis.com/Project",
						state,
						additionalAttributes: { projectId },
					})),
				})
			)
		}
		const promql = /^\/v1\/projects\/([^/]+)\/location\/global\/prometheus\/api\/v1\/(.+)$/.exec(
			url.pathname,
		)
		if (url.host === "monitoring.googleapis.com" && promql !== null) {
			const call = {
				project: promql[1]!,
				path: promql[2]!,
				params: Object.fromEntries(
					new URLSearchParams(await new Response(init?.body ?? null).text()),
				),
				reader,
				quotaProject: headers.get("x-goog-user-project"),
			}
			calls.promql.push(call)
			return options.promql?.(call) ?? matrix()
		}
		const scope = /^\/v1\/locations\/global\/metricsScopes\/(.+)$/.exec(url.pathname)
		if (url.host === "monitoring.googleapis.com" && scope !== null) {
			const projectId = scope[1]!
			calls.scopes.push(projectId)
			return json({
				name: `locations/global/metricsScopes/${numberOf(projectId)}`,
				monitoredProjects: [projectId, ...(options.scopes?.[projectId] ?? [])].map((monitored) => ({
					name: `locations/global/metricsScopes/${numberOf(projectId)}/projects/${numberOf(monitored)}`,
				})),
			})
		}
		const descriptors = /^\/v3\/projects\/([^/]+)\/metricDescriptors$/.exec(url.pathname)
		if (url.host === "monitoring.googleapis.com" && descriptors !== null) {
			const pageToken = url.searchParams.get("pageToken") ?? ""
			calls.descriptors.push(`${descriptors[1]} ${pageToken}`.trim())
			assert.strictEqual(url.searchParams.get("activeOnly"), "true")
			return options.descriptors?.(descriptors[1]!, pageToken) ?? json({})
		}
		throw new Error(`unexpected request to ${url.href}`)
	}) as typeof fetch

const makeCalls = (): Calls => ({
	oauth: 0,
	impersonate: [],
	promql: [],
	descriptors: [],
	assets: [],
	scopes: [],
})

const run = <A, E>(
	testDb: TestDb,
	stub: typeof fetch,
	effect: Effect.Effect<A, E, GcpLiveMetricsService>,
	options: { readonly key?: string | null } = {},
) => {
	const key = options.key === undefined ? encodedKey : options.key
	return Effect.gen(function* () {
		yield* TestClock.setTime(now)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(GcpLiveMetricsService, GcpLiveMetricsService.make).pipe(
				Layer.provide(FetchHttpClient.layer),
				Layer.provide(Layer.succeed(FetchHttpClient.Fetch, stub)),
				Layer.provide(EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))),
				Layer.provide(testDb.layer),
				Layer.provide(Env.layer),
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
							...(key === null ? undefined : { MAPLE_GCP_SERVICE_ACCOUNT_KEY: key }),
						}),
					),
				),
			),
		),
	)
}

const insertConnector = (
	testDb: TestDb,
	id: string,
	options: {
		readonly orgId?: string
		readonly projectId?: string
		readonly folder?: string
		/** What the setup script reported: the read-only account is in place. */
		readonly metricsOn?: boolean | null
	} = {},
) => {
	const projectId = options.projectId ?? "acme-prod"
	return Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, applied_metrics_enabled, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'c', 'i', 't', $1, $6, 'user_1', now(), now())`,
			[
				id,
				options.orgId ?? ORG,
				options.folder === undefined ? "project" : "folder",
				options.folder ?? projectId,
				projectId,
				options.metricsOn === undefined ? true : options.metricsOn,
			],
		),
	)
}

/** The org's two connections: project `acme-prod`, and folder 123 hosted in `acme-host`. */
const insertConnectors = (testDb: TestDb) =>
	Effect.all([
		insertConnector(testDb, PROJECT_CONNECTOR),
		insertConnector(testDb, FOLDER_CONNECTOR, { projectId: "acme-host", folder: "123" }),
		insertConnector(testDb, OTHER_CONNECTOR, { orgId: OTHER_ORG, projectId: "rival-prod" }),
	])

const FOLDER_PROJECTS = [
	["acme-shop", "ACTIVE"],
	["acme-data", "ACTIVE"],
	["acme-gone", "DELETE_REQUESTED"],
] as const

const T0 = Date.UTC(2026, 9, 15, 11, 0) / 1000

const range = (query: string, projects?: ReadonlyArray<string>) =>
	GcpLiveMetricsService.use((gcp) =>
		gcp.queryRange(TENANT, {
			query,
			startSeconds: T0,
			endSeconds: T0 + 3600,
			stepSeconds: 600,
			...(projects === undefined ? undefined : { projects }),
		}),
	)

const failureScopes = (error: { readonly _tag: string }) =>
	"failures" in error && Array.isArray(error.failures)
		? error.failures.map((failure: { readonly scope: string }) => failure.scope)
		: []

const firstFailure = (error: { readonly _tag: string }) =>
	"failures" in error && Array.isArray(error.failures)
		? (error.failures[0] as { readonly message: string }).message
		: error._tag

describe("GcpLiveMetricsService.queryRange", () => {
	it.effect("reads every project of the org's connections, each with its connection's reader", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				promql: (call) =>
					call.project === "acme-prod"
						? // Google left out `project_id`, and two points are not numbers.
							matrix({
								metric: { service: "checkout" },
								values: [
									[T0, "3"],
									[T0 + 600, "NaN"],
									[T0 + 1200, "+Inf"],
									[T0 + 1800, "1.5"],
								],
							})
						: // Google's own `project_id` stays.
							matrix({
								metric: {
									service: "checkout",
									project_id:
										call.project === "acme-shop" ? "acme-monitored" : call.project,
								},
								values: [[T0, "7"]],
							}),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const series = yield* range("sum by (service) (rate(x[5m]))")

				assert.sameDeepMembers(
					[...series],
					[
						{ labels: { service: "checkout", project_id: "acme-data" }, points: [[T0, 7]] },
						{
							labels: { service: "checkout", project_id: "acme-prod" },
							points: [
								[T0, 3],
								[T0 + 1800, 1.5],
							],
						},
						{ labels: { service: "checkout", project_id: "acme-monitored" }, points: [[T0, 7]] },
					],
				)
				// Only the folder is searched, for projects only; the other org's connection is never read.
				assert.deepStrictEqual(calls.assets, [
					"/v1/folders/123:searchAllResources cloudresourcemanager.googleapis.com/Project",
				])
				assert.sameDeepMembers(
					calls.promql.map(({ project, reader, quotaProject }) => ({
						project,
						reader,
						quotaProject,
					})),
					[
						{ project: "acme-prod", reader: PROJECT_READER, quotaProject: "acme-prod" },
						{ project: "acme-shop", reader: FOLDER_READER, quotaProject: "acme-host" },
						{ project: "acme-data", reader: FOLDER_READER, quotaProject: "acme-host" },
					],
				)
				assert.strictEqual(calls.promql[0]!.path, "query_range")
				assert.deepInclude(calls.promql[0]!.params, {
					query: "sum by (service) (rate(x[5m]))",
					start: String(T0),
					end: String(T0 + 3600),
					step: "600",
				})
			}),
		)
	})

	it.effect("reads only the projects asked for, and refuses one the connections do not reach", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, { folderProjects: FOLDER_PROJECTS }),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				yield* range("up", ["acme-shop"])
				assert.deepStrictEqual(
					calls.promql.map((call) => call.project),
					["acme-shop"],
				)

				for (const outside of ["rival-prod", "acme-gone"]) {
					const error = yield* Effect.flip(range("up", ["acme-shop", outside]))
					assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
					assert.strictEqual("reason" in error ? error.reason : undefined, "invalid_query")
					assert.include(error.message, outside)
				}
				assert.lengthOf(calls.promql, 1)
			}),
		)
	})

	it.effect("refuses to read more than 20 projects unless the query filters on project_id", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const many = Array.from({ length: 20 }, (_, index) => [`acme-team-${index + 10}`, "ACTIVE"] as const)
		return run(
			testDb,
			stubFetch(calls, { folderProjects: many }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, FOLDER_CONNECTOR, { projectId: "acme-host", folder: "123" })
				yield* range("up")
				assert.lengthOf(calls.promql, 20)

				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range("down"))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
				assert.strictEqual("reason" in error ? error.reason : undefined, "too_many_projects")
				assert.include(error.message, "21 projects")
				assert.include(error.message, "project_id")
				assert.include(error.message, "acme-prod")
				assert.lengthOf(calls.promql, 20)

				yield* range("up", ["acme-team-10", "acme-prod"])
				assert.sameMembers(
					calls.promql.slice(20).map((call) => call.project),
					["acme-prod", "acme-team-10"],
				)
			}),
		)
	})

	it.effect("returns what answered when part fails, and fails only when nothing answered", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				promql: (call) =>
					call.project === "acme-prod"
						? matrix({ metric: { project_id: "acme-prod" }, values: [[T0, "1"]] })
						: denied(),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const series = yield* range("up")
				assert.deepStrictEqual(series, [{ labels: { project_id: "acme-prod" }, points: [[T0, 1]] }])

				const error = yield* Effect.flip(range("up", ["acme-data", "acme-shop"]))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryFailedError")
				assert.sameMembers(failureScopes(error), ["projects/acme-data", "projects/acme-shop"])
				assert.strictEqual(
					firstFailure(error),
					"Google denied Maple's read of folder 123: the read-only roles are missing. Grant them with the setup script, the console steps or your Terraform. A new grant can take a few minutes. (Cloud Monitoring returned 403 PERMISSION_DENIED)",
				)
			}),
		)
	})

	it.effect("reads the rest when a connection cannot sign in or its projects cannot be listed", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				assets: denied,
				promql: (call) => matrix({ metric: { project_id: call.project }, values: [[T0, "1"]] }),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const series = yield* range("up")
				assert.deepStrictEqual(
					series.map((one) => one.labels.project_id),
					["acme-prod"],
				)

				// A project the failed listing may hold is not refused as unknown.
				const error = yield* Effect.flip(range("up", ["acme-shop"]))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryFailedError")
				assert.deepStrictEqual(failureScopes(error), ["folders/123"])
				assert.include(firstFailure(error), "Cloud Asset Viewer is missing")
			}),
		)
	})

	it.effect("passes Google's refusal of the query on as an invalid query", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const refusal = `invalid parameter "query": ${"x".repeat(2_000)}`
		return run(
			testDb,
			stubFetch(calls, {
				promql: (call) =>
					call.params.query === "slow"
						? json(
								{
									status: "error",
									errorType: "execution",
									error: "query processing would load too many samples",
								},
								422,
							)
						: call.params.query === "busy"
							? // Google's front end answers a rate limit with a small HTML page.
								new Response("<html><body>Too Many Requests</body></html>", {
									status: 429,
									headers: { "content-type": "text/html" },
								})
							: json({ status: "error", errorType: "bad_data", error: refusal }, 400),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range('{"serviceruntime.googleapis.com/api/request_count"}'))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
				assert.strictEqual("reason" in error ? error.reason : undefined, "invalid_query")
				assert.strictEqual(error.message, refusal.slice(0, 1_000))

				const slow = yield* Effect.flip(range("slow"))
				assert.strictEqual(
					firstFailure(slow),
					"Google could not finish the query on this project. Narrow the query or widen the step. (Cloud Monitoring returned 422 execution: query processing would load too many samples)",
				)
				const busy = yield* Effect.flip(range("busy"))
				assert.strictEqual(busy._tag, "@maple/http/errors/GcpLiveQueryFailedError")
				assert.strictEqual(
					firstFailure(busy),
					"Google refused the read for the project acme-prod: a rate limit, or an answer past Google's size limit. Narrow the query, or try again in a few minutes. (Cloud Monitoring returned 429)",
				)
			}),
		)
	})

	it.effect("refuses an answer of more than 500 series across its projects, never cut short", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				// 250 series from each project: 750 in all, 500 from the folder alone.
				promql: (call) =>
					matrix(
						...Array.from({ length: 250 }, (_, index) => ({
							metric: { instance: `vm-${index}`, project_id: call.project },
							values: [[T0, "1"]] as Array<[number, string]>,
						})),
					),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const error = yield* Effect.flip(range("up"))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
				assert.strictEqual("reason" in error ? error.reason : undefined, "too_many_series")
				assert.include(error.message, "group by fewer labels")

				const atTheCap = yield* range("up", ["acme-shop", "acme-data"])
				assert.lengthOf(atTheCap, 500)
			}),
		)
	})

	it.effect("refuses a project's answer past 8 MB as too many series", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				promql: () => matrix({ metric: { pod: "x".repeat(9 * 1024 * 1024) }, values: [[T0, "1"]] }),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range("up"))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
				assert.strictEqual("reason" in error ? error.reason : undefined, "too_many_series")
				assert.include(error.message, "larger than 8 MB")
			}),
		)
	})

	it.effect("reads a project another target's metrics scope holds through that scope, once", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				scopes: { "acme-data": ["acme-shop"] },
				// What Google answers for `sum by (service)`: no `project_id`.
				promql: (call) =>
					matrix({
						metric: { service: "checkout" },
						values: [[T0, call.project === "acme-data" ? "9" : "3"]],
					}),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const series = yield* range("sum by (service) (rate(x[5m]))")
				assert.sameMembers(
					calls.promql.map((call) => call.project),
					["acme-data", "acme-prod"],
				)
				// acme-data's sum covers acme-shop too, so it names the scope, not a project.
				assert.sameDeepMembers(
					series.map((one) => one.labels),
					[
						{ service: "checkout", metrics_scope: "acme-data" },
						{ service: "checkout", project_id: "acme-prod" },
					],
				)
			}),
		)
	})

	it.effect("reads only connections with metrics on, and is unavailable without one", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const other = Schema.decodeSync(OrgId)(OTHER_ORG)
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				promql: (call) => matrix({ metric: { project_id: call.project }, values: [[T0, "1"]] }),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				yield* insertConnector(testDb, FOLDER_CONNECTOR, {
					projectId: "acme-host",
					folder: "123",
					metricsOn: null,
				})
				yield* insertConnector(testDb, OTHER_CONNECTOR, {
					orgId: OTHER_ORG,
					projectId: "rival-prod",
					metricsOn: false,
				})
				const series = yield* range("up")
				assert.deepStrictEqual(
					series.map((one) => one.labels.project_id),
					["acme-prod"],
				)
				assert.deepStrictEqual(calls.assets, [])
				assert.deepStrictEqual(calls.impersonate, [PROJECT_READER])

				const error = yield* Effect.flip(
					GcpLiveMetricsService.use((gcp) =>
						gcp.queryRange(
							{ orgId: other },
							{ query: "up", startSeconds: T0, endSeconds: T0, stepSeconds: 60 },
						),
					),
				)
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryUnavailableError")
				assert.strictEqual(
					error.message,
					"Connect Google Cloud with metrics on to query Google Cloud metrics.",
				)
			}),
		)
	})

	it.effect("is unavailable without Maple's Google key, before any call", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range("up"))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryUnavailableError")
				assert.deepStrictEqual(calls, makeCalls())
			}),
			{ key: null },
		)
	})

	it.effect("says a refusal of Maple's own project is Maple's, not the connection's setup", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				impersonate: () => googleError(403, "PERMISSION_DENIED", "SERVICE_DISABLED"),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range("up"))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryFailedError")
				assert.strictEqual(
					firstFailure(error),
					"Maple's request to Google's IAM Credentials API failed. Try again in a few minutes. If this repeats, write to support@maple.dev. (IAM Credentials returned 403 PERMISSION_DENIED, SERVICE_DISABLED)",
				)
			}),
		)
	})

	it.effect("tells a connection whose grant is missing what to do", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, { impersonate: denied }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(range("up"))
				assert.deepStrictEqual(failureScopes(error), ["projects/acme-prod"])
				assert.include(firstFailure(error), "run the setup script again")
			}),
		)
	})

	it.effect("signs in once and reuses the tokens for later queries", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, { folderProjects: FOLDER_PROJECTS }),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				yield* range("up")
				yield* range("down")
				assert.strictEqual(calls.oauth, 1)
				assert.sameMembers(calls.impersonate, [PROJECT_READER, FOLDER_READER])
				// The folder's projects and each project's metrics scope are read once an hour, not per query.
				assert.lengthOf(calls.assets, 1)
				assert.lengthOf(calls.scopes, 3)
				// Answers are not cached: each query reads Google.
				assert.lengthOf(calls.promql, 6)

				// Ten minutes on, both tokens have expired.
				yield* TestClock.adjust("10 minutes")
				yield* range("sideways")
				assert.strictEqual(calls.oauth, 2)
				assert.lengthOf(calls.impersonate, 4)
			}),
		)
	})
})

describe("GcpLiveMetricsService.queryInstant", () => {
	it.effect("reads one point per series, a scalar as one series, and refuses a string", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const instant = (query: string) =>
			GcpLiveMetricsService.use((gcp) => gcp.queryInstant(TENANT, { query, timeSeconds: T0 }))
		return run(
			testDb,
			stubFetch(calls, {
				promql: (call) =>
					call.params.query === "up"
						? json({
								status: "success",
								data: {
									resultType: "vector",
									result: [
										{ metric: { project_id: "acme-prod", zone: "a" }, value: [T0, "4"] },
									],
								},
							})
						: call.params.query === '"text"'
							? json({
									status: "success",
									data: { resultType: "string", result: [T0, "text"] },
								})
							: json({ status: "success", data: { resultType: "scalar", result: [T0, "2"] } }),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				assert.deepStrictEqual(yield* instant("up"), [
					{ labels: { project_id: "acme-prod", zone: "a" }, points: [[T0, 4]] },
				])
				assert.strictEqual(calls.promql[0]!.path, "query")
				assert.deepInclude(calls.promql[0]!.params, { query: "up", time: String(T0) })

				assert.deepStrictEqual(yield* instant("1 + 1"), [
					{ labels: { project_id: "acme-prod" }, points: [[T0, 2]] },
				])

				const text = yield* Effect.flip(instant('"text"'))
				assert.strictEqual(text._tag, "@maple/http/errors/GcpLiveQueryRejectedError")
				assert.include(text.message, "String results are not supported")
			}),
		)
	})
})

const descriptor = (type: string, extra: Record<string, unknown> = {}) => ({
	type,
	metricKind: "GAUGE",
	valueType: "DOUBLE",
	unit: "1",
	description: `${type} description`,
	...extra,
})

describe("GcpLiveMetricsService discovery", () => {
	it.effect("lists the active metrics of every project, merged per type, and caches them", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const CPU = "cloudsql.googleapis.com/database/cpu/utilization"
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				descriptors: (project, pageToken) => {
					if (project === "acme-prod") {
						return pageToken === ""
							? json({
									metricDescriptors: [
										descriptor(CPU, {
											monitoredResourceTypes: ["cloudsql_database"],
											labels: [{ key: "database", description: "The database." }],
										}),
										// A logging metric: Google lists no resource types.
										descriptor("logging.googleapis.com/user/checkout_errors", {
											metricKind: "DELTA",
											valueType: "INT64",
											labels: [{ key: "severity" }],
										}),
									],
									nextPageToken: "page-2",
								})
							: json({
									metricDescriptors: [
										descriptor("run.googleapis.com/request_latencies", {
											metricKind: "DELTA",
											valueType: "DISTRIBUTION",
											monitoredResourceTypes: ["cloud_run_revision"],
										}),
									],
								})
					}
					if (project === "acme-shop") {
						return json({
							metricDescriptors: [
								descriptor(CPU, {
									monitoredResourceTypes: [
										"cloudsql_instance_database",
										"cloudsql_database",
									],
									labels: [{ key: "replica" }, { key: "database" }],
								}),
								// A kind Google leaves unspecified is not a metric Maple can query.
								descriptor("custom.googleapis.com/odd", {
									metricKind: "METRIC_KIND_UNSPECIFIED",
								}),
							],
						})
					}
					return denied()
				},
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const metrics = yield* GcpLiveMetricsService.use((gcp) => gcp.listMetrics(TENANT))
				assert.deepStrictEqual(metrics, [
					{
						type: CPU,
						metricKind: "GAUGE",
						valueType: "DOUBLE",
						unit: "1",
						description: `${CPU} description`,
						monitoredResourceTypes: ["cloudsql_database", "cloudsql_instance_database"],
						labels: ["database", "replica"],
					},
					{
						type: "logging.googleapis.com/user/checkout_errors",
						metricKind: "DELTA",
						valueType: "INT64",
						unit: "1",
						description: "logging.googleapis.com/user/checkout_errors description",
						monitoredResourceTypes: [],
						labels: ["severity"],
					},
					{
						type: "run.googleapis.com/request_latencies",
						metricKind: "DELTA",
						valueType: "DISTRIBUTION",
						unit: "1",
						description: "run.googleapis.com/request_latencies description",
						monitoredResourceTypes: ["cloud_run_revision"],
						labels: [],
					},
				])
				assert.sameMembers(calls.descriptors, [
					"acme-prod",
					"acme-prod page-2",
					"acme-shop",
					"acme-data",
				])

				// From the cache: only the project that failed is read again.
				const described = yield* GcpLiveMetricsService.use((gcp) => gcp.describeMetric(TENANT, CPU))
				assert.deepStrictEqual(described?.labels, ["database", "replica"])
				assert.lengthOf(calls.descriptors, 5)
				assert.isUndefined(
					yield* GcpLiveMetricsService.use((gcp) =>
						gcp.describeMetric(TENANT, "custom.googleapis.com/odd"),
					),
				)
			}),
		)
	})

	it.effect("fails the listing only when no project answered", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, { descriptors: denied }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(GcpLiveMetricsService.use((gcp) => gcp.listMetrics(TENANT)))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpLiveQueryFailedError")
				assert.deepStrictEqual(failureScopes(error), ["projects/acme-prod"])
			}),
		)
	})
})
