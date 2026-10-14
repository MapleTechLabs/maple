import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { GcpPromQlInstantRequest, GcpPromQlRangeRequest } from "@maple/domain/http"
import { GcpProjectId, OrgId } from "@maple/domain/primitives"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { GcpPromQlService } from "./GcpPromQlService"

const now = Date.UTC(2026, 9, 15, 12, 0, 0)
const ORG = Schema.decodeSync(OrgId)("org_gcp")
const OTHER_ORG = "org_other"
const project = Schema.decodeSync(GcpProjectId)

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

interface PromQlCall {
	readonly project: string
	/** `query`, `query_range` or `label/__name__/values`. */
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
	readonly descriptors: Array<string>
	readonly assets: Array<string>
}

interface StubOptions {
	readonly impersonate?: (account: string) => Response | undefined
	readonly promql?: (call: PromQlCall) => Response | undefined
	/** Projects under `folders/123`, as `[projectId, state]`. */
	readonly folderProjects?: ReadonlyArray<readonly [string, string]>
	readonly names?: ReadonlyArray<string>
	readonly descriptors?: Record<string, unknown>
}

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
			return json({
				results: (options.folderProjects ?? []).map(([projectId, state]) => ({
					name: `//cloudresourcemanager.googleapis.com/projects/${projectId.length}0001`,
					assetType: "cloudresourcemanager.googleapis.com/Project",
					state,
					additionalAttributes: { projectId },
				})),
			})
		}
		const promql = /^\/v1\/projects\/([^/]+)\/location\/global\/prometheus\/api\/v1\/(.+)$/.exec(
			url.pathname,
		)
		if (url.host === "monitoring.googleapis.com" && promql !== null) {
			const call = {
				project: promql[1]!,
				path: promql[2]!,
				params: Object.fromEntries(url.searchParams),
				reader,
				quotaProject: headers.get("x-goog-user-project"),
			}
			calls.promql.push(call)
			if (call.path === "label/__name__/values")
				return json({ status: "success", data: options.names ?? [] })
			return options.promql?.(call) ?? matrix()
		}
		if (url.host === "monitoring.googleapis.com" && url.pathname.endsWith("/metricDescriptors")) {
			const type = /metric\.type = "([^"]+)"/.exec(url.searchParams.get("filter") ?? "")?.[1] ?? ""
			calls.descriptors.push(type)
			const descriptor = options.descriptors?.[type]
			return json(descriptor === undefined ? {} : { metricDescriptors: [descriptor] })
		}
		throw new Error(`unexpected request to ${url.href}`)
	}) as typeof fetch

const makeCalls = (): Calls => ({ oauth: 0, impersonate: [], promql: [], descriptors: [], assets: [] })

const run = <A, E>(
	testDb: TestDb,
	stub: typeof fetch,
	effect: Effect.Effect<A, E, GcpPromQlService>,
	options: { readonly key?: string | null } = {},
) => {
	const key = options.key === undefined ? encodedKey : options.key
	return Effect.gen(function* () {
		yield* TestClock.setTime(now)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(GcpPromQlService, GcpPromQlService.make).pipe(
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
		readonly metricsEnabled?: boolean
	} = {},
) => {
	const projectId = options.projectId ?? "acme-prod"
	return Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, metrics_enabled, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, $5, 'c', 'i', 't', $1, $6, 'user_1', now(), now())`,
			[
				id,
				options.orgId ?? ORG,
				options.folder === undefined ? "project" : "folder",
				options.folder ?? projectId,
				projectId,
				options.metricsEnabled ?? false,
			],
		),
	)
}

/** The org's two connections: project `acme-prod`, and folder 123 hosted in `acme-host`. */
const insertConnectors = (testDb: TestDb) =>
	Effect.all([
		insertConnector(testDb, PROJECT_CONNECTOR),
		insertConnector(testDb, FOLDER_CONNECTOR, {
			projectId: "acme-host",
			folder: "123",
			metricsEnabled: true,
		}),
		insertConnector(testDb, OTHER_CONNECTOR, { orgId: OTHER_ORG, projectId: "rival-prod" }),
	])

const FOLDER_PROJECTS = [
	["acme-shop", "ACTIVE"],
	["acme-data", "ACTIVE"],
	["acme-gone", "DELETE_REQUESTED"],
] as const

const range = (query: string, projects?: ReadonlyArray<string>) =>
	new GcpPromQlRangeRequest({
		query,
		startTime: "2026-10-15 10:59:30",
		endTime: "2026-10-15 11:59:30",
		stepSeconds: 600,
		...(projects === undefined ? undefined : { projects: projects.map((id) => project(id)) }),
	})

const queryRange = (request: GcpPromQlRangeRequest) =>
	GcpPromQlService.use((gcp) => gcp.queryRange(ORG, request))

const T0 = Date.UTC(2026, 9, 15, 11, 0) / 1000

describe("GcpPromQlService.queryRange", () => {
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
						: matrix({
								metric: { service: "checkout", project_id: call.project },
								values: [[T0, "7"]],
							}),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const result = yield* queryRange(range("sum by (service) (rate(x[5m]))"))

				assert.deepStrictEqual<ReadonlyArray<string>>(result.projects, ["acme-data", "acme-prod", "acme-shop"])
				assert.deepStrictEqual(result.failures, [])
				assert.strictEqual(result.resultType, "matrix")
				// Identical label sets from different projects stay apart by `project_id`.
				assert.sameDeepMembers(
					result.series.map((series) => ({ labels: series.labels, points: series.points })),
					[
						{ labels: { service: "checkout", project_id: "acme-data" }, points: [[T0, 7]] },
						{
							labels: { service: "checkout", project_id: "acme-prod" },
							points: [
								[T0, 3],
								[T0 + 1800, 1.5],
							],
						},
						{ labels: { service: "checkout", project_id: "acme-shop" }, points: [[T0, 7]] },
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
				// The window is aligned to the step.
				assert.deepInclude(calls.promql[0]!.params, {
					query: "sum by (service) (rate(x[5m]))",
					start: String(T0 - 600),
					end: String(T0 + 3600),
					step: "600",
				})
				assert.strictEqual(calls.promql[0]!.path, "query_range")
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
				const result = yield* queryRange(range("up", ["acme-shop"]))
				assert.deepStrictEqual<ReadonlyArray<string>>(result.projects, ["acme-shop"])
				assert.deepStrictEqual(
					calls.promql.map((call) => call.project),
					["acme-shop"],
				)

				for (const outside of ["rival-prod", "acme-gone"]) {
					const error = yield* Effect.flip(queryRange(range("up", ["acme-shop", outside])))
					assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
					assert.include(error.message, outside)
				}
				assert.lengthOf(calls.promql, 1)
			}),
		)
	})

	it.effect("refuses to read more than 20 projects unless they are chosen", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const many = Array.from({ length: 21 }, (_, index) => [`acme-team-${index + 10}`, "ACTIVE"] as const)
		return run(
			testDb,
			stubFetch(calls, { folderProjects: many }),
			Effect.gen(function* () {
				yield* insertConnector(testDb, FOLDER_CONNECTOR, { projectId: "acme-host", folder: "123" })
				const error = yield* Effect.flip(queryRange(range("up")))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpPromQlTooManyProjectsError")
				assert.lengthOf(
					error._tag === "@maple/http/errors/GcpPromQlTooManyProjectsError" ? error.projects : [],
					21,
				)
				assert.lengthOf(calls.promql, 0)

				const chosen = yield* queryRange(range("up", ["acme-team-10", "acme-team-30"]))
				assert.deepStrictEqual<ReadonlyArray<string>>(chosen.projects, ["acme-team-10", "acme-team-30"])
			}),
		)
	})

	it.effect("returns what answered beside what failed, and fails only when nothing answered", () => {
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
				const result = yield* queryRange(range("up"))
				assert.deepStrictEqual<ReadonlyArray<string>>(result.projects, ["acme-prod"])
				assert.lengthOf(result.series, 1)
				assert.deepStrictEqual(
					result.failures.map((failure) => failure.scope),
					["projects/acme-data", "projects/acme-shop"],
				)
				assert.strictEqual(
					result.failures[0]!.message,
					"Google denied Maple's read of folder 123: the read-only roles are missing. Run the setup script again: it grants them. A new grant can take a few minutes. (Cloud Monitoring returned 403 PERMISSION_DENIED)",
				)

				const error = yield* Effect.flip(queryRange(range("up", ["acme-data", "acme-shop"])))
				assert.strictEqual(error._tag, "@maple/http/errors/GcpPromQlFailedError")
			}),
		)
	})

	it.effect("reports a connection without a read-only account on its own, and reads the rest", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				folderProjects: FOLDER_PROJECTS,
				impersonate: (account) => (account === FOLDER_READER ? denied() : undefined),
				promql: (call) => matrix({ metric: { project_id: call.project }, values: [[T0, "1"]] }),
			}),
			Effect.gen(function* () {
				yield* insertConnectors(testDb)
				const result = yield* queryRange(range("up"))
				assert.deepStrictEqual<ReadonlyArray<string>>(result.projects, ["acme-prod"])
				assert.deepStrictEqual(result.failures, [
					{
						scope: "folders/123",
						message:
							"Maple can't sign in as this connection's read-only service account, which live queries read with. Run the setup script again: it creates the account and the grant to Maple. A new grant can take a few minutes. (IAM Credentials returned 403 PERMISSION_DENIED)",
					},
				])
			}),
		)
	})

	it.effect("passes Google's refusal of the query on as an invalid query", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		const refusal =
			"invalid parameter \"query\": substitute queries failed: must specify a label matcher on the 'monitored_resource' label"
		return run(
			testDb,
			stubFetch(calls, {
				promql: () => json({ status: "error", errorType: "bad_data", error: refusal }, 400),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const error = yield* Effect.flip(
					queryRange(range('{"serviceruntime.googleapis.com/api/request_count"}')),
				)
				assert.strictEqual(error._tag, "@maple/http/errors/GcpPromQlInvalidQueryError")
				assert.strictEqual(error.message, refusal)
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
				yield* queryRange(range("up"))
				yield* queryRange(range("down"))
				assert.strictEqual(calls.oauth, 1)
				assert.sameMembers(calls.impersonate, [PROJECT_READER, FOLDER_READER])
				// The folder's projects are searched once an hour, not per query.
				assert.lengthOf(calls.assets, 1)
				assert.lengthOf(calls.promql, 6)

				// Ten minutes on, both tokens have expired.
				yield* TestClock.adjust("10 minutes")
				yield* queryRange(range("sideways"))
				assert.strictEqual(calls.oauth, 2)
				assert.lengthOf(calls.impersonate, 4)
			}),
		)
	})

	it.effect("answers unavailable without a key, and not connected without a connection", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return Effect.gen(function* () {
			const unavailable = yield* run(
				testDb,
				stubFetch(calls),
				Effect.gen(function* () {
					yield* insertConnector(testDb, PROJECT_CONNECTOR)
					return yield* Effect.flip(queryRange(range("up")))
				}),
				{ key: null },
			)
			assert.strictEqual(unavailable._tag, "@maple/http/errors/GcpPromQlUnavailableError")

			const notConnected = yield* run(
				testDb,
				stubFetch(calls),
				Effect.flip(
					GcpPromQlService.use((gcp) =>
						gcp.queryRange(Schema.decodeSync(OrgId)("org_empty"), range("up")),
					),
				),
			)
			assert.strictEqual(notConnected._tag, "@maple/http/errors/IntegrationsNotConnectedError")
			assert.deepStrictEqual(calls, makeCalls())
		})
	})
})

describe("GcpPromQlService.queryInstant", () => {
	it.effect("reads one point per series at the minute, a scalar as one series", () => {
		const testDb = createTestDb(trackedDbs)
		const calls = makeCalls()
		return run(
			testDb,
			stubFetch(calls, {
				promql: () => json({ status: "success", data: { resultType: "scalar", result: [T0, "2"] } }),
			}),
			Effect.gen(function* () {
				yield* insertConnector(testDb, PROJECT_CONNECTOR)
				const result = yield* GcpPromQlService.use((gcp) =>
					gcp.queryInstant(
						ORG,
						new GcpPromQlInstantRequest({ query: "1 + 1", time: "2026-10-15 11:00:42" }),
					),
				)
				assert.deepInclude(calls.promql[0]!, { path: "query" })
				assert.deepInclude(calls.promql[0]!.params, { query: "1 + 1", time: String(T0) })
				assert.strictEqual(result.resultType, "vector")
				assert.deepStrictEqual(result.series, [
					{ labels: { project_id: "acme-prod" }, points: [[T0, 2]] },
				])
			}),
		)
	})
})

describe("GcpPromQlService discovery", () => {
	it.effect(
		"searches one project's UTF-8 metric names and describes a distribution by its PromQL name",
		() => {
			const testDb = createTestDb(trackedDbs)
			const calls = makeCalls()
			return run(
				testDb,
				stubFetch(calls, {
					names: [
						"run.googleapis.com/request_count",
						"run_googleapis_com:request_count",
						"run.googleapis.com/request_latencies_bucket",
						"compute.googleapis.com/instance/cpu/utilization",
					],
					descriptors: {
						"run.googleapis.com/request_latencies": {
							type: "run.googleapis.com/request_latencies",
							metricKind: "DELTA",
							valueType: "DISTRIBUTION",
							unit: "ms",
							description: "Distribution of request latency.",
							monitoredResourceTypes: ["cloud_run_instance", "cloud_run_revision"],
							labels: [
								{ key: "response_code", description: "Response code of a request." },
								{ key: "route" },
							],
						},
					},
				}),
				Effect.gen(function* () {
					yield* insertConnector(testDb, PROJECT_CONNECTOR)
					const search = yield* GcpPromQlService.use((gcp) =>
						gcp.searchMetrics(ORG, { search: "RUN.googleapis" }),
					)
					assert.deepStrictEqual(search.projectId, "acme-prod")
					assert.deepStrictEqual(search.metrics, [
						"run.googleapis.com/request_count",
						"run.googleapis.com/request_latencies_bucket",
					])
					const limited = yield* GcpPromQlService.use((gcp) =>
						gcp.searchMetrics(ORG, { search: "run", limit: 1 }),
					)
					assert.deepStrictEqual(limited.metrics, ["run.googleapis.com/request_count"])
					// The name list is read once and searched from the cache after.
					assert.lengthOf(calls.promql, 1)

					const descriptor = yield* GcpPromQlService.use((gcp) =>
						gcp.describeMetric(ORG, { type: "run.googleapis.com/request_latencies_bucket" }),
					)
					assert.deepInclude(descriptor, {
						type: "run.googleapis.com/request_latencies",
						metricKind: "DELTA",
						valueType: "DISTRIBUTION",
						unit: "ms",
					})
					assert.deepStrictEqual(descriptor.monitoredResourceTypes, [
						"cloud_run_instance",
						"cloud_run_revision",
					])
					assert.deepStrictEqual(descriptor.labels, [
						{ key: "response_code", description: "Response code of a request." },
						{ key: "route", description: "" },
					])

					const missing = yield* Effect.flip(
						GcpPromQlService.use((gcp) =>
							gcp.describeMetric(ORG, { type: "custom.googleapis.com/nothing" }),
						),
					)
					assert.strictEqual(missing._tag, "@maple/http/errors/IntegrationsNotFoundError")
					const outside = yield* Effect.flip(
						GcpPromQlService.use((gcp) =>
							gcp.describeMetric(ORG, {
								type: "run.googleapis.com/request_count",
								project: project("rival-prod"),
							}),
						),
					)
					assert.strictEqual(outside._tag, "@maple/http/errors/IntegrationsValidationError")
				}),
			)
		},
	)
})
