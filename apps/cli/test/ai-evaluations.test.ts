// `gen_ai.evaluation.result` reaches `ai_evaluations` on a real ClickHouse engine, from both
// encodings: an OTLP log record (event name in `LogAttributes['event.name']`, the evaluated span in
// its context) and a span event on the evaluated span. A view that never fires reads as "no scores"
// forever, so this proves rows, not SQL text.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { CH as Compile, formatWarehouseDateTime } from "@maple/query-engine"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { OrgId } from "@maple/domain"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_ai_evaluations"
/** Recent, so the 30- and 90-day TTLs keep every seed. */
const AT_MS = Math.floor(Date.now() / 1000) * 1000 - 3_600_000
const TRACE = "0af7651916cd43dd8448eb211c80319c"
const SPAN = "b7ad6b7169203331"

const ts = (ms: number) => Str.slice(0, 19)(Str.replace("T", " ")(new Date(ms).toISOString()))

const map = (entries: Readonly<Record<string, string>>) =>
	`map(${Arr.join(
		Arr.map(Rec.toEntries(entries), ([key, value]) => `'${key}', '${value}'`),
		", ",
	)})`

const list = <A>(items: ReadonlyArray<A>, render: (item: A) => string) =>
	`[${Arr.join(Arr.map(items, render), ", ")}]`

const insertLog = (db: Chdb, attributes: Readonly<Record<string, string>>, traceId = TRACE, spanId = SPAN) =>
	db.exec(
		`INSERT INTO logs (OrgId, Timestamp, TimestampTime, TraceId, SpanId, ServiceName, Body, LogAttributes, ResourceAttributes) VALUES ('${ORG}', '${ts(AT_MS)}', '${ts(AT_MS)}', '${traceId}', '${spanId}', 'evaluator', '', ${map(attributes)}, ${map({ "deployment.environment.name": "production" })})`,
	)

const insertSpan = (db: Chdb, events: ReadonlyArray<readonly [string, Readonly<Record<string, string>>]>) =>
	db.exec(
		`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ServiceName, SpanName, EventsTimestamp, EventsName, EventsAttributes) VALUES ('${ORG}', '${ts(AT_MS)}', '${TRACE}', 'c1c1c1c1c1c1c1c1', 'agent', 'chat claude', ${list(events, () => `'${ts(AT_MS + 1000)}'`)}, ${list(events, ([name]) => `'${name}'`)}, ${list(events, ([, attrs]) => map(attrs))})`,
	)

const Row = Schema.Struct({
	TraceId: Schema.String,
	SpanId: Schema.String,
	Name: Schema.String,
	ScoreValue: CH.CHNumber,
	HasScore: CH.CHNumber,
	ScoreLabel: Schema.String,
	Verdict: Schema.String,
	Explanation: Schema.String,
	Scope: Schema.String,
	Source: Schema.String,
	AnnotatorKind: Schema.String,
	ServiceName: Schema.String,
	DeploymentEnv: Schema.String,
})

const rows = (db: Chdb) =>
	decodeJsonEachRow(Row)(
		db.query(
			`SELECT TraceId, SpanId, Name, ScoreValue, HasScore, ScoreLabel, Verdict, Explanation, Scope, Source, AnnotatorKind, ServiceName, DeploymentEnv FROM ai_evaluations WHERE OrgId = '${ORG}' ORDER BY Name`,
		),
	)

describeWithChdb("ai_evaluations views", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-ai-evaluations-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("projects evaluation log records and span events, and nothing else", () => {
		insertLog(db, {
			"event.name": "gen_ai.evaluation.result",
			"gen_ai.evaluation.name": "Relevance",
			"gen_ai.evaluation.score.value": "0.82",
			"gen_ai.evaluation.explanation": "Answers the question",
			"maple_ai.evaluation.annotator_kind": "llm",
		})
		insertLog(db, {
			"event.name": "gen_ai.evaluation.result",
			"gen_ai.evaluation.name": "Task completion",
			"gen_ai.evaluation.score.label": "FAIL",
			"maple_ai.evaluation.scope": "session",
			"maple_ai.evaluation.source": "maple_check",
			"maple_ai.evaluation.target.trace_id": "11111111111111111111111111111111",
		})
		// A non-finite value is no score: it would poison every mean.
		insertLog(db, {
			"event.name": "gen_ai.evaluation.result",
			"gen_ai.evaluation.name": "Toxicity",
			"gen_ai.evaluation.score.value": "nan",
		})
		// Another event and a plain log: neither is a score.
		insertLog(db, { "event.name": "gen_ai.client.inference.operation.details" })
		insertLog(db, { "gen_ai.evaluation.name": "Not an event" })
		insertSpan(db, [
			["exception", { "exception.message": "boom" }],
			[
				"gen_ai.evaluation.result",
				{ "gen_ai.evaluation.name": "Groundedness", "gen_ai.evaluation.score.label": "pass" },
			],
		])

		expect(rows(db)).toEqual([
			{
				TraceId: TRACE,
				SpanId: "c1c1c1c1c1c1c1c1",
				Name: "Groundedness",
				ScoreValue: 0,
				HasScore: 0,
				ScoreLabel: "pass",
				Verdict: "pass",
				Explanation: "",
				Scope: "span",
				Source: "otel",
				AnnotatorKind: "",
				ServiceName: "agent",
				DeploymentEnv: "",
			},
			{
				TraceId: TRACE,
				SpanId: SPAN,
				Name: "Relevance",
				ScoreValue: 0.82,
				HasScore: 1,
				ScoreLabel: "",
				Verdict: "",
				Explanation: "Answers the question",
				Scope: "span",
				Source: "otel",
				AnnotatorKind: "llm",
				ServiceName: "evaluator",
				DeploymentEnv: "production",
			},
			{
				// The target replaces the context as a pair: no span from the record's own trace.
				TraceId: "11111111111111111111111111111111",
				SpanId: "",
				Name: "Task completion",
				ScoreValue: 0,
				HasScore: 0,
				ScoreLabel: "FAIL",
				Verdict: "fail",
				Explanation: "",
				Scope: "session",
				Source: "maple_check",
				AnnotatorKind: "",
				ServiceName: "evaluator",
				DeploymentEnv: "production",
			},
			{
				TraceId: TRACE,
				SpanId: SPAN,
				Name: "Toxicity",
				ScoreValue: 0,
				HasScore: 0,
				ScoreLabel: "",
				Verdict: "",
				Explanation: "",
				Scope: "span",
				Source: "otel",
				AnnotatorKind: "",
				ServiceName: "evaluator",
				DeploymentEnv: "production",
			},
		])
	})
})

describeWithChdb("ai_evaluations reads", () => {
	let root = ""
	let db: Chdb
	const params = {
		orgId: Schema.decodeSync(OrgId)(ORG),
		startTime: formatWarehouseDateTime(AT_MS - 3_600_000),
		endTime: formatWarehouseDateTime(AT_MS + 3_600_000),
	}
	const run = <A>(compiled: { readonly sql: string }, schema: Schema.Codec<A, unknown>) =>
		decodeJsonEachRow(schema)(db.query(normalizeSqlForClickHouseClient(compiled.sql)))

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-ai-evaluations-reads-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const score = (name: string, extra: Readonly<Record<string, string>>, traceId = TRACE) =>
			insertLog(
				db,
				{ "event.name": "gen_ai.evaluation.result", "gen_ai.evaluation.name": name, ...extra },
				traceId,
			)
		score("Relevance", { "gen_ai.evaluation.score.value": "0.5" })
		score("Relevance", { "gen_ai.evaluation.score.value": "1" })
		score("Task completion", { "gen_ai.evaluation.score.label": "pass" })
		score(
			"Task completion",
			{ "gen_ai.evaluation.score.label": "fail", "gen_ai.evaluation.explanation": "gave up" },
			"22222222222222222222222222222222",
		)
		score(
			"Task completion",
			{ "gen_ai.evaluation.score.label": "fail", "error.type": "timeout" },
			"33333333333333333333333333333333",
		)
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	test("summarizes each evaluator: verdicts, a mean only over numeric scores, evaluation failures", () => {
		const rows = run(
			Compile.compileUnsafe(CH.aiEvaluationsSummaryQuery(), params),
			Schema.Struct({
				name: Schema.String,
				scoreCount: CH.CHNumber,
				passCount: CH.CHNumber,
				failCount: CH.CHNumber,
				valueCount: CH.CHNumber,
				avgValue: CH.CHNumber,
				errorCount: CH.CHNumber,
				traceCount: CH.CHNumber,
			}),
		)
		expect(rows).toEqual([
			{
				name: "Task completion",
				scoreCount: 3,
				passCount: 1,
				failCount: 2,
				valueCount: 0,
				avgValue: 0,
				errorCount: 1,
				traceCount: 3,
			},
			{
				name: "Relevance",
				scoreCount: 2,
				passCount: 0,
				failCount: 0,
				valueCount: 2,
				avgValue: 0.75,
				errorCount: 0,
				traceCount: 1,
			},
		])
	})

	test("lists a session's scores by its traces, failing first", () => {
		const rows = run(
			Compile.compileUnsafe(
				CH.aiEvaluationScoresQuery({
					traceIds: [TRACE, "22222222222222222222222222222222"],
					sessionId: "s1",
				}),
				params,
			),
			Schema.Struct({
				name: Schema.String,
				verdict: Schema.String,
				traceId: Schema.String,
				explanation: Schema.String,
			}),
		)
		expect(rows[0]).toEqual({
			name: "Task completion",
			verdict: "fail",
			traceId: "22222222222222222222222222222222",
			explanation: "gave up",
		})
		expect(rows.length).toBe(4)
	})
})
