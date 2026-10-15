// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// The fingerprint end to end: spans go into a real ClickHouse, its error views
// hash them, and the real errors tick turns the hashes into Postgres issues.

import { randomUUID } from "node:crypto"
import { afterAll, afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { FetchHttpClient } from "effect/http"
import { migrations } from "@maple/domain/clickhouse"
import { OrgId } from "@maple/domain/http"
import { ErrorIssueId } from "@maple/domain/primitives"
import { FINGERPRINT_VERSION } from "@maple/domain/tinybird/fingerprint"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssues } from "@maple/db/tables"
import { EdgeCacheService, MemoryCacheBackendLive } from "@maple/cache"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { NotificationDispatcher } from "@maple/backend/services/alerts/NotificationDispatcher"
import { TinybirdOrgTokenService } from "@maple/backend/services/integrations/TinybirdOrgTokenService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	clickhousePassword,
	clickhouseUrl,
	clickhouseUser,
	uniqueDatabase,
} from "@maple/backend/services/warehouse/clickhouse-e2e-support"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"
import { ErrorPolicyService } from "./ErrorPolicyService"
import { ErrorsService } from "./ErrorsService"
import { InvestigationService } from "./InvestigationService"

const ORG = Schema.decodeSync(OrgId)("org_error_tick_fingerprint_e2e")
const asIssueId = Schema.decodeSync(ErrorIssueId)
const SERVICE = "api"
const createdDbs: TestDb[] = []
const createdDatabases: string[] = []

afterEach(() => cleanupTestDbs(createdDbs))
afterAll(async () => {
	for (const name of createdDatabases) await clickhouseExec(`DROP DATABASE IF EXISTS ${name}`)
})

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

interface Span {
	readonly type: string
	readonly message: string
	readonly stacktrace: string
}

const frames = (...lines: ReadonlyArray<string>) => ["Error: boom", ...lines].join("\n")

/**
 * Inside the tick's bootstrap window: the cutoff trails now by the ingestion lag
 * (1-2 minutes) and the window opens 2 minutes before that.
 */
const spanTimestamp = () =>
	new Date(Date.now() - 150_000).toISOString().replace("T", " ").replace("Z", "").slice(0, 23)

/** Three of each, so every fingerprint clears the promotion threshold. */
const insertSpans = async (database: string, spans: ReadonlyArray<Span>): Promise<void> => {
	const ts = spanTimestamp()
	const rows = spans.flatMap((span) =>
		[1, 2, 3].map((n) => {
			const spanId = randomUUID()
			return `(${quote(ORG)}, ${quote(ts)}, ${quote(`trace-${spanId}`)}, ${quote(spanId)}, '', 'GET /', 'Server', ${quote(SERVICE)}, 1000000, 'Error', ${quote(span.message)}, map(), map('service.version', ${quote(`1.0.${n}`)}), [toDateTime64(${quote(ts)}, 9)], ['exception'], [map('exception.type', ${quote(span.type)}, 'exception.message', ${quote(span.message)}, 'exception.stacktrace', ${quote(span.stacktrace)})])`
		}),
	)
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, EventsTimestamp, EventsName, EventsAttributes)
		 VALUES\n${rows.join(",\n")}`,
		database,
	)
}

const materializedHashes = async (database: string): Promise<ReadonlyArray<string>> =>
	(
		await clickhouseExec(
			`SELECT DISTINCT toString(FingerprintHash) FROM error_events WHERE OrgId = ${quote(ORG)} ORDER BY 1 FORMAT TabSeparated`,
			database,
		)
	)
		.split("\n")
		.filter((line) => line !== "")

const prepareWarehouse = async (): Promise<string> => {
	const database = uniqueDatabase("maple_error_tick_fp_e2e")
	createdDatabases.push(database)
	await clickhouseExec(`CREATE DATABASE IF NOT EXISTS ${database}`)
	await applyRealMigrations(database)
	return database
}

/** The tick's real service graph over one ClickHouse database and one test Postgres. */
const makeTickLayer = (database: string) => {
	const testDb = createTestDb(createdDbs)
	const databaseLive = testDb.layer
	const envLive = Env.layer.pipe(
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "http://127.0.0.1:7181",
					TINYBIRD_TOKEN: "unused-for-vanilla-clickhouse",
					CLICKHOUSE_URL: clickhouseUrl,
					CLICKHOUSE_PROVIDER: "clickhouse",
					CLICKHOUSE_USER: clickhouseUser,
					CLICKHOUSE_PASSWORD: clickhousePassword,
					CLICKHOUSE_DATABASE: database,
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: ORG,
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "error-tick-e2e-lookup-key",
					MAPLE_INGEST_PUBLIC_URL: "http://127.0.0.1:3474",
					MAPLE_APP_BASE_URL: "http://127.0.0.1:3471",
				}),
			),
		),
	)
	const edgeCacheLive = EdgeCacheService.layer.pipe(Layer.provide(MemoryCacheBackendLive))
	const warehouseLive = Layer.effect(WarehouseQueryService, WarehouseQueryService.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(
			Layer.mergeAll(
				envLive,
				OrgClickHouseSettingsService.layer.pipe(
					Layer.provide(Layer.mergeAll(envLive, databaseLive, edgeCacheLive)),
				),
				TinybirdOrgTokenService.layer.pipe(Layer.provide(envLive)),
			),
		),
	)
	const errorActorsLive = ErrorActorsService.layer.pipe(Layer.provide(databaseLive))
	const errorIssueWorkflowLive = Layer.effect(
		ErrorIssueWorkflowService,
		ErrorIssueWorkflowService.make,
	).pipe(
		Layer.provide(AuditLogService.layerMemory),
		Layer.provide(databaseLive),
		Layer.provide(errorActorsLive),
	)
	return Layer.effect(ErrorsService, ErrorsService.make).pipe(
		Layer.provide(envLive),
		Layer.provide(databaseLive),
		Layer.provide(warehouseLive),
		Layer.provide(edgeCacheLive),
		Layer.provide(
			Layer.succeed(NotificationDispatcher, {
				dispatch: () => Effect.succeed({ delivered: 0, failed: 0 }),
			}),
		),
		Layer.provide(errorActorsLive),
		Layer.provide(errorIssueWorkflowLive),
		Layer.provide(ErrorPolicyService.layer.pipe(Layer.provide(databaseLive))),
		Layer.provide(InvestigationService.layer.pipe(Layer.provide(Layer.mergeAll(envLive, databaseLive)))),
		Layer.provideMerge(databaseLive),
	)
}

/**
 * An org with issue state is always scanned. Discovery itself is pinned to the
 * managed warehouse, which this harness does not run.
 */
const PLACEHOLDER_HASH = "placeholder"
const seedOrgState = Effect.gen(function* () {
	const database = yield* Database
	const now = Date.now()
	yield* database.execute((db) =>
		db.run(
			PG.insertInto(ErrorIssues).values({
				id: asIssueId(randomUUID()),
				orgId: ORG,
				fingerprintHash: PLACEHOLDER_HASH,
				fingerprintVersion: FINGERPRINT_VERSION,
				serviceName: SERVICE,
				exceptionType: "Placeholder",
				exceptionMessage: "",
				topFrame: "",
				firstSeenAt: now,
				lastSeenAt: now,
				createdAt: now,
				updatedAt: now,
			}),
		),
	)
})

const loadIssues = Effect.gen(function* () {
	const database = yield* Database
	return yield* database.execute((db) =>
		db.run(
			PG.from(ErrorIssues)
				.select()
				.where(($) => [$.orgId.eq(ORG), $.fingerprintHash.neq(PLACEHOLDER_HASH)]),
		),
	)
})

describe.skipIf(!clickhouseE2eEnabled)("errors tick over the v3 fingerprint (ClickHouse e2e)", () => {
	it.live(
		"groups real spans into the issues v3 intends, stamped with the current version",
		() =>
			Effect.gen(function* () {
				const database = yield* Effect.promise(prepareWarehouse)
				const upstream = (caller: string, status: number): Span => ({
					type: "@maple/http/errors/UpstreamUnavailable",
					message: `upstream returned ${status}`,
					stacktrace: frames(
						"    at toUpstreamError (/app/src/upstream.ts:40:11)",
						`    at ${caller} (/app/src/${caller}.ts:12:3)`,
					),
				})
				const echo = (query: string): Span => ({
					type: "",
					message: `[Error] Unknown identifier \`ServiceVersion\` in scope ${query}`,
					stacktrace: "",
				})
				yield* Effect.promise(() =>
					insertSpans(database, [
						// One outage, two callers, two 5xx codes: one issue.
						upstream("listTraces", 502),
						upstream("serviceMap", 524),
						// One missing column, two queries: one issue.
						echo("SELECT ServiceVersion FROM traces"),
						echo("SELECT * FROM (SELECT ServiceVersion FROM logs)"),
						// Two different client errors: two issues.
						upstream("listTraces", 401),
						upstream("listTraces", 404),
					]),
				)
				const hashes = yield* Effect.promise(() => materializedHashes(database))
				assert.lengthOf(hashes, 4)

				return yield* Effect.gen(function* () {
					yield* seedOrgState
					const errors = yield* ErrorsService
					yield* errors.runTick()

					const issues = yield* loadIssues
					assert.sameMembers(
						issues.map((issue) => issue.fingerprintHash),
						[...hashes],
					)
					for (const issue of issues) {
						assert.strictEqual(issue.fingerprintVersion, FINGERPRINT_VERSION)
						assert.isNull(issue.archivedAt)
					}
					// The two merged issues carry both spans' occurrences; 401 and 404 their own.
					assert.deepStrictEqual(
						issues.map((issue) => issue.occurrenceCount).sort((a, b) => a - b),
						[3, 3, 6, 6],
					)
				}).pipe(Effect.provide(makeTickLayer(database)))
			}),
		120_000,
	)

	it.live(
		"brings back an archived issue a lagging warehouse still hashes the old way",
		() =>
			Effect.gen(function* () {
				// A self-hosted warehouse that has not applied migration 0039 yet: put
				// the v2 views (0030) back over the v3 ones.
				const database = yield* Effect.promise(prepareWarehouse)
				const v2 = migrations.find((migration) => migration.version === 30)
				assert.isDefined(v2)
				for (const statement of v2.statements) {
					assert.isString(statement)
					yield* Effect.promise(() => clickhouseExec(statement, database))
				}
				yield* Effect.promise(() =>
					insertSpans(database, [
						{
							type: "DatabaseError",
							message: "connection reset by peer",
							stacktrace: frames("    at query (/app/src/db.ts:5:1)"),
						},
					]),
				)
				const [v2Hash] = yield* Effect.promise(() => materializedHashes(database))
				assert.isString(v2Hash)

				return yield* Effect.gen(function* () {
					// Archived by the version sweep while its old hash was still live.
					const issueId = asIssueId(randomUUID())
					const db = yield* Database
					const archivedAt = Date.now() - 60 * 60_000
					yield* db.execute((tx) =>
						tx.run(
							PG.insertInto(ErrorIssues).values({
								id: issueId,
								orgId: ORG,
								fingerprintHash: v2Hash,
								fingerprintVersion: FINGERPRINT_VERSION - 1,
								serviceName: SERVICE,
								exceptionType: "DatabaseError",
								exceptionMessage: "connection reset by peer",
								topFrame: "",
								workflowState: "in_progress",
								priority: 1,
								occurrenceCount: 40,
								firstSeenAt: archivedAt - 86_400_000,
								lastSeenAt: archivedAt,
								archivedAt,
								createdAt: archivedAt - 86_400_000,
								updatedAt: archivedAt,
							}),
						),
					)
					const errors = yield* ErrorsService
					yield* errors.runTick()

					const [issue] = yield* loadIssues
					assert.isDefined(issue)
					assert.strictEqual(issue.id, issueId)
					assert.isNull(issue.archivedAt)
					assert.strictEqual(issue.workflowState, "in_progress")
					assert.strictEqual(issue.priority, 1)
					assert.strictEqual(issue.occurrenceCount, 43)
					assert.strictEqual(issue.fingerprintVersion, FINGERPRINT_VERSION)
				}).pipe(Effect.provide(makeTickLayer(database)))
			}),
		120_000,
	)
})
