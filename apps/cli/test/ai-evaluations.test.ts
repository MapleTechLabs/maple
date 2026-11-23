// `gen_ai.evaluation.result` reaches `ai_evaluations` on a real ClickHouse engine, from both
// encodings: an OTLP log record (event name in `LogAttributes['event.name']`, the evaluated span in
// its context) and a span event on the evaluated span. A view that never fires reads as "no scores"
// forever, so this proves rows, not SQL text.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
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
		// A target trace with no target span grades the trace; an uppercase id is stored as span rows store it.
		insertLog(db, {
			"event.name": "gen_ai.evaluation.result",
			"gen_ai.evaluation.name": "Answer quality",
			"gen_ai.evaluation.score.label": "pass",
			"maple_ai.evaluation.target.trace_id": "4BF92F3577B34DA6A3CE929D0E0E4736",
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
				TraceId: "4bf92f3577b34da6a3ce929d0e0e4736",
				SpanId: "",
				Name: "Answer quality",
				ScoreValue: 0,
				HasScore: 0,
				ScoreLabel: "pass",
				Verdict: "pass",
				Explanation: "",
				Scope: "trace",
				Source: "otel",
				AnnotatorKind: "",
				ServiceName: "evaluator",
				DeploymentEnv: "production",
			},
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
