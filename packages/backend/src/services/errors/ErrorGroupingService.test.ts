import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, Clock, Effect, Layer, Schema } from "effect"
import { ErrorIssueId, OrgId, UserId } from "@maple/primitives"
import { ErrorIssueFingerprints, ErrorIssues } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { OrgGroupingRule } from "@maple/domain/tinybird/grouping-rules"
import { GroupingRulesUpdateRequest } from "@maple/domain/http"
import type { CompiledQuery } from "@maple/query-engine/ch"
import { compiledQueryOf } from "@maple/query-engine/execution"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import type {
	SqlQueryOptions,
	WarehouseQueryServiceApi,
} from "@maple/backend/services/warehouse/WarehouseQueryService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { ErrorActorsService } from "./ErrorActorsService"
import { ErrorGroupingService } from "./ErrorGroupingService"
import { ErrorIssueWorkflowService } from "./ErrorIssueWorkflowService"

const ORG = Schema.decodeSync(OrgId)("org_error_grouping_test")
const USER = Schema.decodeSync(UserId)("user_error_grouping_test")
const asIssueId = Schema.decodeUnknownSync(ErrorIssueId)
const createdDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(createdDbs))

interface WarehouseRows {
	samples: ReadonlyArray<Record<string, unknown>>
	spans: ReadonlyArray<Record<string, unknown>>
}

const warehouseStub = (rows: WarehouseRows): WarehouseQueryServiceApi => ({
	query: () => Effect.die(new Error("unexpected warehouse query")),
	rawSqlQuery: () => Effect.succeed([]),
	crossOrgQuery: () => Effect.die(new Error("unexpected warehouse query")),
	compiledQuery: <T>(_tenant: unknown, compiled: CompiledQuery<T>, options?: SqlQueryOptions) =>
		Effect.suspend(() =>
			Effect.orDie(
				compiledQueryOf(compiled).decodeRows(
					options?.context === "errorGroupingExplainSamples"
						? rows.samples
						: options?.context === "errorGroupingExplainSpans"
							? rows.spans
							: [],
				),
			),
		),
	compiledQueryFirst: () => Effect.die(new Error("unexpected warehouse query")),
	ingest: () => Effect.void,
	asExecutor: () => {
		throw new Error("asExecutor is not supported by this test stub")
	},
})

const makeLayer = (rows: WarehouseRows = { samples: [], spans: [] }) => {
	const database = createTestDb(createdDbs).layer
	const actors = ErrorActorsService.layer.pipe(Layer.provide(database))
	const workflow = Layer.effect(ErrorIssueWorkflowService, ErrorIssueWorkflowService.make).pipe(
		Layer.provide(Layer.mergeAll(database, actors, AuditLogService.layerMemory)),
	)
	const grouping = Layer.effect(ErrorGroupingService, ErrorGroupingService.make).pipe(
		Layer.provide(
			Layer.mergeAll(database, workflow, Layer.succeed(WarehouseQueryService, warehouseStub(rows))),
		),
	)
	return grouping.pipe(Layer.provideMerge(database))
}

const seedIssue = (overrides: Partial<PG.InsertRowOf<typeof ErrorIssues>>) =>
	Effect.gen(function* () {
		const database = yield* Database
		const now = yield* Clock.currentTimeMillis
		const id = asIssueId(randomUUID())
		yield* database.execute((db) =>
			db.run(
				PG.insertInto(ErrorIssues).values({
					id,
					orgId: ORG,
					fingerprintHash: randomUUID(),
					serviceName: "checkout-api",
					exceptionType: "CustomerQueryError",
					exceptionMessage: "relation orders does not exist",
					topFrame: "",
					firstSeenAt: now,
					lastSeenAt: now,
					createdAt: now,
					updatedAt: now,
					...overrides,
				}),
			),
		)
		return id
	})

describe("ErrorGroupingService rules", () => {
	it.effect("saves rules and refuses ones that cannot work", () =>
		Effect.gen(function* () {
			const grouping = yield* ErrorGroupingService
			assert.deepStrictEqual((yield* grouping.getRules(ORG)).rules, [])
			const rule = new OrgGroupingRule({ id: "timeouts", kind: "merge", message: "*timed out*" })
			const saved = yield* grouping.updateRules(
				ORG,
				USER,
				new GroupingRulesUpdateRequest({ rules: [rule], expectedUpdatedAt: null }),
			)
			assert.strictEqual(saved.rules[0]?.id, "timeouts")
			assert.isNotNull(saved.updatedAt)

			const bad = yield* Effect.flip(
				grouping.updateRules(
					ORG,
					USER,
					new GroupingRulesUpdateRequest({
						rules: [
							new OrgGroupingRule({ id: "a", kind: "library-frames" }),
							new OrgGroupingRule({ id: "b", kind: "merge" }),
							rule,
							rule,
						],
						expectedUpdatedAt: saved.updatedAt,
					}),
				),
			)
			assert.strictEqual(bad._tag, "@maple/http/errors/ErrorValidationError")
			assert.lengthOf(bad.details, 3)
		}).pipe(Effect.provide(makeLayer())),
	)

	it.effect("refuses a save built on rules that changed since", () =>
		Effect.gen(function* () {
			const grouping = yield* ErrorGroupingService
			const first = new OrgGroupingRule({ id: "a", kind: "merge", message: "*a*" })
			yield* grouping.updateRules(
				ORG,
				USER,
				new GroupingRulesUpdateRequest({ rules: [first], expectedUpdatedAt: null }),
			)

			const stale = yield* Effect.flip(
				grouping.updateRules(
					ORG,
					USER,
					new GroupingRulesUpdateRequest({ rules: [], expectedUpdatedAt: null }),
				),
			)

			assert.include(stale.message, "changed since")
			assert.lengthOf((yield* grouping.getRules(ORG)).rules, 1)
		}).pipe(Effect.provide(makeLayer())),
	)
})

describe("ErrorGroupingService.similarIssues", () => {
	it.effect("suggests open issues of the same service and type with a similar message", () =>
		Effect.gen(function* () {
			const grouping = yield* ErrorGroupingService
			const issue = yield* seedIssue({ exceptionMessage: "relation orders does not exist" })
			const close = yield* seedIssue({ exceptionMessage: "relation invoices does not exist" })
			yield* seedIssue({ exceptionMessage: "connection refused by upstream" })
			yield* seedIssue({
				exceptionType: "OtherError",
				exceptionMessage: "relation orders does not exist",
			})
			yield* seedIssue({ serviceName: "billing", exceptionMessage: "relation orders does not exist" })
			yield* seedIssue({ exceptionMessage: "relation orders does not exist", archivedAt: 1 })

			const similar = yield* grouping.similarIssues(ORG, issue)

			assert.deepStrictEqual(
				Arr.map(similar.issues, (entry) => entry.id),
				[close],
			)
			assert.isAtLeast(similar.issues[0]?.similarity ?? 0, 0.5)
		}).pipe(Effect.provide(makeLayer())),
	)
})

describe("ErrorGroupingService.explainIssue", () => {
	it.effect("names the rule behind each fingerprint the issue owns", () => {
		const timestamp = formatWarehouseDateTime(Date.now() - 60_000)
		const sample = (fingerprintHash: string, chunk: string) => ({
			fingerprintHash,
			serviceName: "checkout-api",
			serviceVersion: "",
			timestamp,
			traceId: `t-${fingerprintHash}`,
			spanId: `s-${fingerprintHash}`,
			exceptionType: "SiteUnavailable",
			statusMessage: "Site is unavailable",
			exceptionStacktrace: `SiteUnavailable: Site is unavailable\n    at Hr (dist/assets/${chunk}.js:1:1)`,
		})
		const span = (fingerprintHash: string) => ({
			traceId: `t-${fingerprintHash}`,
			spanId: `s-${fingerprintHash}`,
			spanName: "resolve",
			spanKind: "Internal",
			spanFingerprint: "",
			eventsName: '["exception"]',
			eventsAttributes: "[{}]",
		})
		return Effect.gen(function* () {
			const grouping = yield* ErrorGroupingService
			const database = yield* Database
			const issue = yield* seedIssue({ fingerprintHash: "1001", exceptionType: "SiteUnavailable" })
			yield* database.execute((db) =>
				db.run(
					PG.insertInto(ErrorIssueFingerprints).values({
						orgId: ORG,
						fingerprintHash: "1002",
						issueId: issue,
						source: "group",
						originIssueId: null,
						createdAt: 1,
					}),
				),
			)

			const explained = yield* grouping.explainIssue(ORG, issue)

			assert.deepStrictEqual(
				Arr.map(explained.fingerprints, (entry) => [entry.fingerprintHash, entry.source, entry.rule]),
				[
					["1001", "primary", "type-message"],
					["1002", "group", null],
				],
			)
			assert.strictEqual(explained.fingerprints[0]?.messageSignature, "Site is unavailable")
		}).pipe(
			Effect.provide(
				makeLayer({
					samples: [sample("1001", "a-BaWgZTwa"), sample("1002", "b-VejMLjva")],
					spans: [span("1001")],
				}),
			),
		)
	})
})
