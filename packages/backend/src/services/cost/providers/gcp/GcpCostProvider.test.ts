import { afterEach, assert, beforeAll, describe, it } from "@effect/vitest"
import { GcpServiceAccountKey } from "@maple/infra/secrets"
import { OrgId } from "@maple/domain/http"
import { ConfigProvider, DateTime, Effect, Layer, Option, Schema, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	insertTestSource,
	type TestDb,
} from "@maple/backend/testing/test-pglite"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import type { CostProviderError, CostPullRow } from "../../CostProvider"
import { MAX_BYTES_BILLED } from "./bigquery"
import { GcpCostProvider, MAX_RESULT_ROWS, MAX_WAITS } from "./GcpCostProvider"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_gcp")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const CONNECTOR = "018f2b3c-4d5e-4f70-8192-a3b4c5d6e7f8"
const READER = "maple-018f2b3c4d5e4f708192a3b4@acme-prod.iam.gserviceaccount.com"
const EXPORT_ID = "export-1"
const TABLE = "billing-proj.billing_export.gcp_billing_export_resource_v1_01ABCD_234567_89ABCD"
const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-04" }
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-04T06:00:00Z"))
const READER_TOKEN = "ya29.customer-reader-token"

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
	const lines = Arr.join(Option.getOrThrow(Str.match(/.{1,64}/g)(body)), "\n")
	encodedKey = Buffer.from(
		JSON.stringify({
			type: "service_account",
			private_key_id: "key-1",
			private_key: `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`,
			client_email: "collector@maple-prod.iam.gserviceaccount.com",
		}),
	).toString("base64")
})

/** A result row as BigQuery answers it: every cell a string, null where the column is. */
const cells = (values: ReadonlyArray<string | null>) => ({ f: Arr.map(values, (v) => ({ v })) })

const line = (
	overrides: Partial<Record<"day" | "service" | "costType" | "cost" | "credits" | "resource", string>> = {},
) =>
	cells([
		overrides.day ?? "2026-11-02",
		"acme-prod",
		overrides.service ?? "Compute Engine",
		"N2 Instance Core running in Americas",
		"us-central1",
		overrides.resource ?? "//compute.googleapis.com/projects/acme-prod/zones/us-central1-a/instances/123",
		overrides.costType ?? "regular",
		"USD",
		"hour",
		overrides.cost ?? "10.5",
		"12",
		overrides.credits ?? "-2.5",
		"24",
	])

interface World {
	tableStatus: number
	tableBody: unknown
	queryStatus: number
	queryBody: unknown
	/** Pages served after the first, by page token or job poll, in order. */
	pages: Array<unknown>
}

const makeWorld = (overrides: Partial<World> = {}): World => ({
	tableStatus: 200,
	tableBody: {
		schema: { fields: [{ name: "cost" }, { name: "resource" }, { name: "cost_at_list" }] },
		timePartitioning: { type: "DAY" },
	},
	queryStatus: 200,
	queryBody: { jobComplete: true, jobReference: { jobId: "job_1", location: "US" }, rows: [line()] },
	pages: [],
	...overrides,
})

const fakeGoogle = (world: World) =>
	VendorFake.make({
		routes: [
			{
				path: "/token",
				respond: () => VendorFake.json({ access_token: "ya29.maple", expires_in: 600 }),
			},
			{
				path: /:generateAccessToken$/,
				respond: () => VendorFake.json({ accessToken: READER_TOKEN }),
			},
			{
				method: "GET",
				path: /\/tables\//,
				respond: () => VendorFake.json(world.tableBody, world.tableStatus),
			},
			{
				method: "POST",
				path: /\/queries$/,
				respond: () => VendorFake.json(world.queryBody, world.queryStatus),
			},
			{
				method: "GET",
				path: /\/queries\//,
				respond: () => VendorFake.json(world.pages.shift() ?? {}),
			},
		],
	})

const insertConnector = (
	testDb: TestDb,
	options: { readonly orgId?: string; readonly metricsEnabled?: boolean } = {},
) =>
	Effect.promise(async () => {
		const orgId = options.orgId ?? ORG
		const sourceId = await insertTestSource(testDb, {
			orgId,
			platform: "gcp",
			name: "Google Cloud acme-prod",
		})
		await executeSql(
			testDb,
			`INSERT INTO gcp_connectors
			   (id, org_id, scope_type, scope_id, project_id, secret_ciphertext, secret_iv, secret_tag,
			    secret_hash, metrics_enabled, created_by, created_at, updated_at, source_id)
			 VALUES ($1, $2, 'project', 'acme-prod', 'acme-prod', 'c', 'i', 't', $1, $3, 'user_1', now(), now(), $4)`,
			[CONNECTOR, orgId, options.metricsEnabled ?? true, sourceId],
		)
		await executeSql(
			testDb,
			`INSERT INTO gcp_cost_exports
			   (id, org_id, connector_id, table_ref, billing_account_id, created_by, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, '01ABCD-234567-89ABCD', 'user_1', now(), now())`,
			[EXPORT_ID, orgId, CONNECTOR, TABLE],
		)
	})

const run = <A, E>(
	testDb: TestDb,
	fake: VendorFake.VendorFake,
	effect: Effect.Effect<A, E, GcpCostProvider>,
	key: string | null = encodedKey,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(GcpCostProvider, GcpCostProvider.make).pipe(
				Layer.provide(
					Layer.mergeAll(FetchHttpClient.layer, testDb.layer, GcpServiceAccountKey.layer),
				),
				Layer.provide(fake.layer),
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown(
							key === null ? {} : { MAPLE_GCP_SERVICE_ACCOUNT_KEY: key },
						),
					),
				),
			),
		),
	)

const pull = (orgId: OrgId = ORG) =>
	GcpCostProvider.use((provider) => provider.pull({ orgId, connectionRef: EXPORT_ID }, WINDOW))

const reasonOf = (error: CostProviderError) => ({ reason: error.reason, message: error.message })

const summary = (row: CostPullRow) => [
	row.day,
	row.chargeCategory,
	row.billedCost,
	row.listCost,
	row.estimated,
]

describe("GcpCostProvider", () => {
	it.effect(
		"queries the export as the connector's reader, in its host project, and splits out credits",
		() => {
			const testDb = createTestDb(trackedDbs)
			const fake = fakeGoogle(makeWorld())
			return Effect.gen(function* () {
				yield* insertConnector(testDb)
				const pulled = yield* run(testDb, fake, pull())

				const impersonated = Arr.findFirst(fake.calls, (call) =>
					Str.endsWith(":generateAccessToken")(call.path),
				)
				assert.include(Option.getOrThrow(impersonated).path, READER)
				const query = Option.getOrThrow(
					Arr.findFirst(
						fake.calls,
						(call) => call.method === "POST" && Str.endsWith("/queries")(call.path),
					),
				)
				assert.strictEqual(query.path, "/bigquery/v2/projects/acme-prod/queries")
				assert.strictEqual(query.authorization, `Bearer ${READER_TOKEN}`)
				assert.strictEqual(query.headers.get("x-goog-user-project"), "acme-prod")
				const body = JSON.parse(query.body)
				assert.include(body.query, `\`${TABLE}\``)
				assert.include(body.query, "resource.global_name")
				assert.include(
					body.query,
					"_PARTITIONTIME >= TIMESTAMP(DATE_SUB(@start_day, INTERVAL 1 DAY))",
				)
				assert.include(body.query, "_PARTITIONTIME < TIMESTAMP(DATE_ADD(@end_day, INTERVAL 45 DAY))")
				// The table is scanned once: the resource ranking runs over the grouped rows.
				assert.lengthOf(body.query.split(TABLE), 2)
				assert.isString(body.requestId)
			// Unnamed charges rank after every named resource.
			assert.include(body.query, "ORDER BY resource = '', resource_cost DESC")
				assert.strictEqual(body.maximumBytesBilled, String(MAX_BYTES_BILLED))
				assert.deepStrictEqual(
					Arr.map(
						body.queryParameters,
						(p: { name: string; parameterValue: { value: string } }) => [
							p.name,
							p.parameterValue.value,
						],
					),
					[
						["start_day", "2026-11-01"],
						["end_day", "2026-11-04"],
					],
				)

				assert.deepStrictEqual(Arr.map(pulled.rows, summary), [
					["2026-11-02", "usage", 10.5, 12, true],
					["2026-11-02", "credit", -2.5, 0, true],
				])
				const [usage] = pulled.rows
				assert.strictEqual(usage?.accountId, "acme-prod")
				assert.strictEqual(usage?.serviceCategory, "Compute")
				assert.strictEqual(usage?.resourceType, "instances")
				// Sign-in, impersonation, table read and query.
				assert.strictEqual(pulled.requests, 4)
			})
		},
	)

	it.effect("leaves resources out of a standard export, and the list price when the table has none", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(makeWorld({ tableBody: { schema: { fields: [{ name: "cost" }] } } }))
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			yield* run(testDb, fake, pull())
			const query = Option.getOrThrow(
				Arr.findFirst(fake.calls, (call) => Str.endsWith("/queries")(call.path)),
			)
			const sql: string = JSON.parse(query.body).query
			assert.notInclude(sql, "resource.global_name")
			assert.notInclude(sql, "cost_at_list")
			assert.notInclude(sql, "_PARTITIONTIME")
		})
	})

	it.effect("waits for a running job, then reads every page", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeWorld({
			queryBody: { jobComplete: false, jobReference: { jobId: "job_1", location: "US" } },
			pages: [
				{ jobComplete: true, jobReference: { jobId: "job_1" }, rows: [line()], pageToken: "p2" },
				{
					jobComplete: true,
					jobReference: { jobId: "job_1" },
					rows: [line({ day: "2026-11-03", credits: "0" })],
				},
			],
		})
		const fake = fakeGoogle(world)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const pulled = yield* run(testDb, fake, pull())
			assert.deepStrictEqual(Arr.map(pulled.rows, summary), [
				["2026-11-02", "usage", 10.5, 12, true],
				["2026-11-02", "credit", -2.5, 0, true],
				["2026-11-03", "usage", 10.5, 12, true],
			])
			const pageReads = Arr.filter(
				fake.calls,
				(call) => call.method === "GET" && Str.includes("/queries/")(call.path),
			)
			assert.deepStrictEqual(
				Arr.map(pageReads, (call) => [call.search.get("location"), call.search.get("pageToken")]),
				[
					["US", null],
					[null, "p2"],
				],
			)
			assert.strictEqual(pulled.requests, 6)
		})
	})

	it.effect("says which grant is missing when BigQuery refuses the reader", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(
			makeWorld({
				tableStatus: 403,
				tableBody: { error: { code: 403, message: "Access Denied", status: "PERMISSION_DENIED" } },
			}),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.deepStrictEqual(reasonOf(error), {
				reason: "not_ready",
				message:
					"The reader account cannot query the billing export. Grant it BigQuery Data Viewer on the export table and BigQuery Job User on project acme-prod.",
			})
			assert.strictEqual(error.requests, 3)
		})
	})

	it.effect("asks for the BigQuery API when the host project has it off", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(
			makeWorld({
				queryStatus: 403,
				queryBody: {
					error: {
						status: "PERMISSION_DENIED",
						details: [
							{
								"@type": "type.googleapis.com/google.rpc.ErrorInfo",
								reason: "SERVICE_DISABLED",
							},
						],
					},
				},
			}),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.deepStrictEqual(reasonOf(error), {
				reason: "not_ready",
				message: "Enable the BigQuery API in project acme-prod.",
			})
		})
	})

	it.effect("reads a BigQuery rate or quota refusal as rate limited, not a missing grant", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(
			makeWorld({
				queryStatus: 403,
				queryBody: {
					error: {
						code: 403,
						status: "PERMISSION_DENIED",
						message:
							"Exceeded rate limits: too many concurrent queries for this project_and_region.",
						errors: [{ reason: "rateLimitExceeded", message: "Exceeded rate limits" }],
					},
				},
			}),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.strictEqual(error.reason, "rate_limited")
		})
	})

	it.effect("gives up on a job still running after the last wait, without storing part of it", () => {
		const testDb = createTestDb(trackedDbs)
		const running = { jobComplete: false, jobReference: { jobId: "job_1", location: "US" } }
		const fake = fakeGoogle(
			makeWorld({ queryBody: running, pages: Arr.makeBy(MAX_WAITS + 1, () => running) }),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.deepStrictEqual([error.reason, error.requests], ["upstream", 4 + MAX_WAITS])
		})
	})

	it.effect("holds a query BigQuery refuses for scanning past the byte cap as too large", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(
			makeWorld({
				queryStatus: 400,
				queryBody: {
					error: {
						status: "INVALID_ARGUMENT",
						message: "Query exceeded limit for bytes billed: 107374182400.",
					},
				},
			}),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.strictEqual(error.reason, "too_large")
		})
	})

	it.effect("refuses a result past the row cap as too large rather than storing part of it", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(
			makeWorld({
				queryBody: {
					jobComplete: true,
					jobReference: { jobId: "job_1" },
					rows: Arr.makeBy(MAX_RESULT_ROWS + 1, () => line()),
				},
			}),
		)
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.strictEqual(error.reason, "too_large")
			assert.strictEqual(error.requests, 4)
		})
	})

	it.effect("asks for Metrics and resources before calling Google when the connector has no reader", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(makeWorld())
		return Effect.gen(function* () {
			yield* insertConnector(testDb, { metricsEnabled: false })
			const error = yield* Effect.flip(run(testDb, fake, pull()))
			assert.strictEqual(error.reason, "not_ready")
			assert.include(error.message, "Metrics and resources")
			assert.lengthOf(fake.calls, 0)
		})
	})

	it.effect("never reads another org's export", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(makeWorld())
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull(OTHER_ORG)))
			assert.strictEqual(error.reason, "auth")
			assert.lengthOf(fake.calls, 0)
		})
	})

	it.effect("fails as auth on a deployment with no Google identity for Maple", () => {
		const testDb = createTestDb(trackedDbs)
		const fake = fakeGoogle(makeWorld())
		return Effect.gen(function* () {
			yield* insertConnector(testDb)
			const error = yield* Effect.flip(run(testDb, fake, pull(), null))
			assert.strictEqual(error.reason, "auth")
			assert.lengthOf(fake.calls, 0)
		})
	})
})
