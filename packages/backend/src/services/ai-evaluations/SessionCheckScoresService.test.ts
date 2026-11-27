import { afterEach, assert, describe, it } from "@effect/vitest"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AiEvaluationRuns } from "@maple/db/tables"
import { OrgId, WarehouseConfigError } from "@maple/domain/http"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { ConfigProvider, Effect, Layer, Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { TestClock } from "effect/testing"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { AiSessionReadService } from "@maple/backend/services/ai-sessions/AiSessionReadService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import {
	ENROLL_LOOKBACK_MS,
	LIST_LOOKBACK_MS,
	MAX_CURSOR_LAG_MS,
	SESSION_IDLE_MS,
	SessionCheckScoresService,
} from "./SessionCheckScoresService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = {
	PORT: "3472",
	TINYBIRD_HOST: "https://api.tinybird.co",
	TINYBIRD_TOKEN: "test-token",
	MAPLE_AUTH_MODE: "self_hosted",
	MAPLE_ROOT_PASSWORD: "test-root-password",
	MAPLE_DEFAULT_ORG_ID: "default",
	MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 3).toString("base64"),
	MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
	MAPLE_INGEST_PUBLIC_URL: "https://ingest.example.com",
}

const ORG = Schema.decodeSync(OrgId)("org_session_checks")
const NOW = Date.UTC(2026, 10, 27, 12, 0, 0)
const minute = 60_000
const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"
/** Idle long enough: its last agent span is 30 minutes old. */
const DONE = "wrun_done"
/** Still running: its last agent span is 2 minutes old. */
const LIVE = "wrun_live"

const at = (ms: number) => `${formatWarehouseDateTime(ms)}.000000000`

const listRow = (sessionId: string, endMs: number) => ({
	sessionId,
	vendorId: "eve",
	vendorVersion: "1",
	traceCount: 1,
	spanCount: 3,
	errorAgentSpans: 1,
	toolErrors: 1,
	turnErrors: 0,
	serviceNames: ["agent-runner"],
	models: ["gpt-5"],
	agentNames: ["maple"],
	firstAgentName: "maple",
	llmCalls: 1,
	toolCalls: 1,
	totalTokens: 1_500,
	inputTokens: 1_200,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	outputTokens: 300,
	reasoningTokens: 0,
	cost: 0.02,
	agentStart: at(endMs - 5_000),
	agentEnd: at(endMs),
	agentDurationMs: 5_000,
})

const span = (
	spanId: string,
	spanName: string,
	offsetMs: number,
	attributes: Record<string, string>,
	statusCode = "Unset",
) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId: spanId === "1111111111111111" ? "" : "1111111111111111",
	spanName,
	spanKind: "Client",
	serviceName: "agent-runner",
	durationMs: 900,
	statusCode,
	statusMessage: statusCode === "Error" ? "tool call failed" : "",
	timestamp: at(NOW - 30 * minute - 5_000 + offsetMs),
	spanAttributes: { "maple_ai.session.id": DONE, "maple_ai.vendor.id": "eve", ...attributes },
})

/** One turn whose tool call failed. */
const doneSpans = [
	span("1111111111111111", "invoke_agent maple", 0, {
		"gen_ai.operation.name": "invoke_agent",
		"gen_ai.agent.name": "maple",
		"maple_ai.llm_call": "0",
	}),
	span("2222222222222222", "chat gpt-5", 500, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "gpt-5",
		"gen_ai.usage.input_tokens": "1200",
		"gen_ai.usage.output_tokens": "300",
		"maple_ai.llm_call": "1",
	}),
	span(
		"3333333333333333",
		"execute_tool run_sql",
		2_000,
		{
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "run_sql",
			"gen_ai.tool.call.id": "call_1",
			"error.type": "tool_error",
			"maple_ai.llm_call": "0",
			"maple_ai.tool_call": "1",
			"maple_ai.error": "1",
		},
		"Error",
	),
]

/** The warehouse, answering each session read by the context it names. */
const warehouse = (
	reads: Array<string>,
	statements: Array<{ readonly context: string; readonly sql: string }>,
	spansFail: boolean,
	crowded: boolean,
) => {
	// Full pages of sessions the cursor already passed: scored, but listed again by the lookback.
	const old = Arr.makeBy(100, (index) => `wrun_old_${index}`)
	const oldEnd = NOW - 2 * 3_600_000 + 5_000
	const rowsFor = (context: string, sql: string): ReadonlyArray<Record<string, unknown>> => {
		reads.push(context)
		statements.push({ context, sql })
		if (crowded && context === "aiSessionsRank")
			return Arr.map(old, (sessionId) => ({
				sessionId,
				agentStart: at(oldEnd - 5_000),
				agentEnd: at(oldEnd),
			}))
		if (crowded && context === "aiSessionsPage")
			return Arr.map(old, (sessionId) => listRow(sessionId, oldEnd))
		switch (context) {
			case "aiSessionsRank":
				return [
					{
						sessionId: DONE,
						agentStart: at(NOW - 30 * minute - 5_000),
						agentEnd: at(NOW - 30 * minute),
					},
					{
						sessionId: LIVE,
						agentStart: at(NOW - 2 * minute - 5_000),
						agentEnd: at(NOW - 2 * minute),
					},
				]
			case "aiSessionsPage":
				return [listRow(DONE, NOW - 30 * minute), listRow(LIVE, NOW - 2 * minute)]
			case "aiSessionWindow":
				return Str.includes(DONE)(sql)
					? [{ startTime: at(NOW - 31 * minute), endTime: at(NOW - 29 * minute), spanCount: 3 }]
					: []
			case "aiSessionSpans":
				return doneSpans
			default:
				return []
		}
	}
	const answer = (
		_tenant: unknown,
		compiled: CompiledQueryInput<unknown>,
		options: { readonly context: string },
	) => {
		const query = compiledQueryOf(compiled)
		if (spansFail && options.context === "aiSessionSpans") {
			reads.push(options.context)
			return Effect.fail(
				new WarehouseConfigError({
					message: "budget exceeded",
					pipeName: "aiSessionSpans",
					clickhouseType: "TIMEOUT_EXCEEDED",
				}),
			)
		}
		return query.decodeRows(rowsFor(options.context, query.sql)).pipe(Effect.orDie)
	}
	return makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: answer as never,
		compiledQueryBounded: answer as never,
	})
}

const IngestBody = Schema.Struct({
	resourceLogs: Schema.Array(
		Schema.Struct({
			resource: Schema.Struct({
				attributes: Schema.Array(
					Schema.Struct({
						key: Schema.String,
						value: Schema.Struct({ stringValue: Schema.String }),
					}),
				),
			}),
			scopeLogs: Schema.Array(
				Schema.Struct({
					logRecords: Schema.Array(
						Schema.Struct({
							eventName: Schema.String,
							attributes: Schema.Array(
								Schema.Struct({
									key: Schema.String,
									value: Schema.Struct({ stringValue: Schema.String }),
								}),
							),
						}),
					),
				}),
			),
		}),
	),
})
const decodeIngestBody = Schema.decodeUnknownSync(Schema.fromJsonString(IngestBody))

const makeWorld = (
	opts: {
		readonly llmEvals?: boolean
		readonly ingestStatus?: number
		readonly spansFail?: boolean
		readonly crowded?: boolean
	} = {},
) => {
	const testDb = createTestDb(trackedDbs)
	const bodies: Array<typeof IngestBody.Type> = []
	const reads: Array<string> = []
	const statements: Array<{ readonly context: string; readonly sql: string }> = []
	const api = VendorFake.make({
		routes: [
			{
				respond: (request) => {
					if (request.url.host !== "ingest.example.com") return undefined
					if ((opts.ingestStatus ?? 200) >= 300)
						return VendorFake.text("unavailable", opts.ingestStatus)
					bodies.push(decodeIngestBody(request.body))
					return VendorFake.json({})
				},
			},
		],
	})
	const layer = Layer.effect(SessionCheckScoresService, SessionCheckScoresService.make).pipe(
		Layer.provide(
			Layer.effect(AiSessionReadService, AiSessionReadService.make).pipe(
				Layer.provide(
					Layer.succeed(
						WarehouseQueryService,
						warehouse(reads, statements, opts.spansFail ?? false, opts.crowded ?? false),
					),
				),
			),
		),
		Layer.provide(
			OrganizationFeatureFlagsService.fixed({
				...DISABLED_ORGANIZATION_FEATURE_FLAGS,
				llmEvals: opts.llmEvals ?? true,
			}),
		),
		Layer.provide(OrgIngestKeysService.layer),
		Layer.provide(FetchHttpClient.layer),
		Layer.provideMerge(testDb.layer),
		Layer.provide(EnvTestLive),
		Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(config))),
		Layer.merge(api.layer),
	)
	return { layer, bodies, reads, statements }
}

const runRow = Effect.gen(function* () {
	const database = yield* Database
	const rows = yield* database.execute((db) =>
		db.run(PG.from(AiEvaluationRuns).select(($) => ({ cursorAt: $.cursorAt, lastError: $.lastError }))),
	)
	return rows
})

const attrs = (record: {
	readonly attributes: ReadonlyArray<{
		readonly key: string
		readonly value: { readonly stringValue: string }
	}>
}) =>
	Rec.fromEntries(
		Arr.map(record.attributes, (attribute): [string, string] => [
			attribute.key,
			attribute.value.stringValue,
		]),
	)

describe("SessionCheckScoresService", () => {
	it.effect("enrolls an org once, an hour back", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			yield* TestClock.adjust(minute)
			yield* scores.enroll(ORG)
			const rows = yield* runRow
			assert.deepStrictEqual(rows, [{ cursorAt: NOW - ENROLL_LOOKBACK_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("scores the finished sessions of the window and moves the cursor past them", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			const result = yield* scores.runTick()
			assert.deepStrictEqual(result, { orgs: 1, sessionsScored: 1, orgsFailed: 0, orgsDeferred: 0 })
			// Listed from an hour before the cursor: the list finds sessions by span start.
			const rank = Arr.findFirst(
				world.statements,
				(statement) => statement.context === "aiSessionsRank",
			)
			assert.ok(
				Str.includes(formatWarehouseDateTime(NOW - ENROLL_LOOKBACK_MS - LIST_LOOKBACK_MS))(
					rank._tag === "Some" ? rank.value.sql : "",
				),
			)
			// The live session is left for a later tick: only the finished one's spans are read.
			assert.deepStrictEqual(
				Arr.filter(world.reads, (context) => context === "aiSessionSpans").length,
				1,
			)
			assert.strictEqual(world.bodies.length, 1)
			const records = Arr.flatMap(world.bodies[0]?.resourceLogs ?? [], (resource) =>
				Arr.flatMap(resource.scopeLogs, (scope) => scope.logRecords),
			)
			const byName = Rec.fromEntries(
				Arr.map(records, (record): [string, Record<string, string>] => [
					attrs(record)["gen_ai.evaluation.name"] ?? "",
					attrs(record),
				]),
			)
			const toolErrors = byName["Session check: Tool errors"]
			assert.strictEqual(toolErrors?.["maple_ai.evaluation.verdict"], "fail")
			assert.strictEqual(toolErrors?.["maple_ai.evaluation.session.id"], DONE)
			assert.strictEqual(toolErrors?.["maple_ai.evaluation.source"], "maple_check")
			assert.strictEqual(toolErrors?.["maple_ai.evaluation.identifier"], "session_check.tool-errors")
			assert.strictEqual(byName["Session checks"]?.["maple_ai.evaluation.verdict"], "fail")
			assert.strictEqual(byName["Session check: Rate limits"]?.["maple_ai.evaluation.verdict"], "pass")
			assert.ok(Arr.every(records, (record) => record.eventName === "gen_ai.evaluation.result"))
			const rows = yield* runRow
			assert.deepStrictEqual(rows, [{ cursorAt: NOW - SESSION_IDLE_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("resumes a long-stuck cursor from the newest hours, not from where it stopped", () => {
		const world = makeWorld()
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(
					PG.update(AiEvaluationRuns)
						.set({ cursorAt: NOW - 30 * 86_400_000 })
						.where(($) => [$.orgId.eq(ORG)]),
				),
			)
			yield* scores.runTick()
			const rank = Arr.findFirst(
				world.statements,
				(statement) => statement.context === "aiSessionsRank",
			)
			assert.ok(
				Str.includes(formatWarehouseDateTime(NOW - MAX_CURSOR_LAG_MS - LIST_LOOKBACK_MS))(
					rank._tag === "Some" ? rank.value.sql : "",
				),
			)
			assert.deepStrictEqual(yield* runRow, [{ cursorAt: NOW - SESSION_IDLE_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("skips a session whose spans cannot be read, and moves on", () => {
		const world = makeWorld({ spansFail: true })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			const result = yield* scores.runTick()
			assert.deepStrictEqual(result, { orgs: 1, sessionsScored: 0, orgsFailed: 0, orgsDeferred: 0 })
			assert.strictEqual(world.bodies.length, 0)
			assert.deepStrictEqual(yield* runRow, [{ cursorAt: NOW - SESSION_IDLE_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps the cursor when the list stops before the sessions it has not seen", () => {
		const world = makeWorld({ crowded: true })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			yield* scores.runTick()
			assert.strictEqual(world.bodies.length, 0)
			assert.deepStrictEqual(yield* runRow, [{ cursorAt: NOW - ENROLL_LOOKBACK_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("scores nothing for an org whose llmEvals flag is off", () => {
		const world = makeWorld({ llmEvals: false })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			yield* scores.runTick()
			assert.deepStrictEqual(world.reads, [])
			assert.deepStrictEqual(yield* runRow, [{ cursorAt: NOW - ENROLL_LOOKBACK_MS, lastError: null }])
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("moves on when the gateway refuses the org, keeping the reason", () => {
		const world = makeWorld({ ingestStatus: 402 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			yield* scores.runTick()
			const [row] = yield* runRow
			assert.strictEqual(row?.cursorAt, NOW - SESSION_IDLE_MS)
			assert.ok(Str.includes("402")(row?.lastError ?? ""))
		}).pipe(Effect.provide(world.layer))
	})

	it.effect("keeps the cursor when a session's scores could not be sent, so the next tick retries", () => {
		const world = makeWorld({ ingestStatus: 503 })
		return Effect.gen(function* () {
			yield* TestClock.setTime(NOW)
			const scores = yield* SessionCheckScoresService
			yield* scores.enroll(ORG)
			const result = yield* scores.runTick()
			assert.strictEqual(result.orgsFailed, 1)
			const [row] = yield* runRow
			assert.strictEqual(row?.cursorAt, NOW - ENROLL_LOOKBACK_MS)
			assert.ok(Str.includes("503")(row?.lastError ?? ""))
		}).pipe(Effect.provide(world.layer))
	})
})
