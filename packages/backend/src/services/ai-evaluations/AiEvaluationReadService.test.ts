import { describe, expect, it } from "@effect/vitest"
import {
	GetAiEvaluatorRequest,
	GetAiSessionEvaluationsRequest,
	ListAiEvaluatorsRequest,
	WarehouseConfigError,
	type TenantContext,
} from "@maple/domain/http"
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { OrgId, UserId } from "@maple/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { Array as Arr, Effect, Layer, Option, Schema, String as Str } from "effect"
import { AiEvaluationReadService } from "./AiEvaluationReadService"

const tenant: TenantContext = {
	orgId: Schema.decodeSync(OrgId)("org_ai_evaluation_reads"),
	userId: Schema.decodeSync(UserId)("user_ai_evaluation_reads"),
	roles: [],
	authMode: "self_hosted",
}

const WINDOW = { startTime: "2026-11-22 00:00:00", endTime: "2026-11-23 00:00:00" }
const TRACE_A = "0af7651916cd43dd8448eb211c80319c"
const TRACE_B = "1bf7651916cd43dd8448eb211c80319d"

type Rows = ReadonlyArray<Record<string, unknown>>

const measures = { scoreCount: 4, passCount: 1, failCount: 2, valueCount: 0, avgValue: 0, errorCount: 1 }

const scoreRow = (traceId: string, verdict: string, extra: Record<string, unknown> = {}) => ({
	timestamp: "2026-11-22 10:00:00.000000000",
	failing: verdict === "fail" ? 1 : 0,
	name: "Task completion",
	traceId,
	spanId: "b7ad6b7169203331",
	responseId: "",
	scope: "span",
	sessionId: "",
	scoreValue: 0,
	hasScore: 0,
	scoreLabel: verdict,
	verdict,
	explanation: "",
	errorType: "",
	annotatorKind: "llm",
	source: "otel",
	evaluatorVersion: "",
	judgeModel: "",
	serviceName: "agent",
	...extra,
})

/** A warehouse answering each statement by what it reads, recording the statements. */
const layerWith = (
	flags: { readonly llmEvals: boolean },
	rowsFor: (sql: string) => Effect.Effect<Rows, WarehouseConfigError>,
) => {
	const statements: string[] = []
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) => {
			const query = compiledQueryOf(compiled)
			statements.push(query.sql)
			return rowsFor(query.sql).pipe(
				Effect.flatMap((rows) => query.decodeRows(rows).pipe(Effect.orDie)),
			)
		}) as never,
	})
	const layer = Layer.effect(AiEvaluationReadService, AiEvaluationReadService.make).pipe(
		Layer.provide(Layer.succeed(WarehouseQueryService, warehouse)),
		Layer.provide(
			OrganizationFeatureFlagsService.fixed({ ...DISABLED_ORGANIZATION_FEATURE_FLAGS, ...flags }),
		),
	)
	return { layer, statements }
}

const isResponseSpansRead = Str.includes("GROUP BY responseId")

const answer = (sql: string): Rows => {
	if (isResponseSpansRead(sql)) return []
	if (Str.includes("FROM ai_trace_index")(sql)) return [{ traceId: TRACE_A, sessionId: "session-1" }]
	if (Str.includes("toStartOfInterval")(sql)) return [{ bucket: "2026-11-22 10:00:00", ...measures }]
	if (Str.includes("GROUP BY serviceName")(sql))
		return [{ serviceName: "agent", deploymentEnv: "prod", ...measures }]
	if (Str.includes("GROUP BY name")(sql))
		return [
			{
				name: "Task completion",
				...measures,
				traceCount: 2,
				sources: ["otel"],
				annotatorKinds: ["llm"],
				lastSeen: "2026-11-22 10:00:00.000000000",
			},
		]
	const scores = [
		scoreRow(TRACE_A, "fail"),
		scoreRow(TRACE_B, "pass", { scoreValue: 0.75, hasScore: 1 }),
		// An offline job's session-scope score: its own trace is in no session, the row names one.
		scoreRow("2cf7651916cd43dd8448eb211c80319e", "pass", { scope: "session", sessionId: "session-9" }),
	]
	// The failures read and the read of everything else, as the warehouse would answer them.
	if (Str.includes("scores.verdict = 'fail'")(sql))
		return Arr.filter(scores, (row) => row.verdict === "fail")
	if (Str.includes("scores.verdict != 'fail'")(sql))
		return Arr.filter(scores, (row) => row.verdict !== "fail")
	if (Str.includes("scores.verdict = 'pass'")(sql))
		return Arr.filter(scores, (row) => row.verdict === "pass")
	return scores
}

describe("AiEvaluationReadService", () => {
	it.effect("refuses an org outside the llmEvals rollout without reading the warehouse", () => {
		const { layer, statements } = layerWith({ llmEvals: false }, (sql) => Effect.succeed(answer(sql)))
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const error = yield* Effect.flip(reads.list(tenant, new ListAiEvaluatorsRequest(WINDOW)))
			expect(error._tag).toBe("@maple/http/ai-evaluations/LlmEvalsDisabledError")
			expect(statements).toEqual([])
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads an evaluator: verdicts, its split, and each score's session resolved per trace", () => {
		const { layer } = layerWith({ llmEvals: true }, (sql) => Effect.succeed(answer(sql)))
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const result = yield* reads.evaluator(
				tenant,
				new GetAiEvaluatorRequest({ ...WINDOW, name: "Task completion", bucketSeconds: 3600 }),
			)
			expect(result.summary?.failCount).toBe(2)
			expect(result.series[0]?.bucket).toBe("2026-11-22 10:00:00")
			expect(result.breakdown[0]?.serviceName).toBe("agent")
			// A label-only score carries no value; a trace in no session links nowhere.
			expect(result.scores[0]).toMatchObject({
				traceId: TRACE_A,
				verdict: "fail",
				sessionId: "session-1",
			})
			expect(result.scores[0]?.value).toBeUndefined()
			expect(result.scores[1]).toMatchObject({ traceId: TRACE_B, value: 0.75 })
			expect(result.scores[1]?.sessionId).toBeUndefined()
			expect(result.scores[2]).toMatchObject({ scope: "session", sessionId: "session-9" })
			expect(result.scores).toHaveLength(3)
		}).pipe(Effect.provide(layer))
	})

	it.effect("a bucket too fine for the window is widened to at most 1000 buckets", () => {
		const { layer, statements } = layerWith({ llmEvals: true }, (sql) => Effect.succeed(answer(sql)))
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const read = (bucketSeconds: number) =>
				reads.evaluator(
					tenant,
					new GetAiEvaluatorRequest({ ...WINDOW, name: "Task completion", bucketSeconds }),
				)
			const bucketOf = (sql: string | undefined) => /INTERVAL (\d+) SECOND/.exec(sql ?? "")?.[1]
			const series = () =>
				Arr.last(Arr.filter(statements, (sql) => Str.includes("toStartOfInterval")(sql)))
			// One day at 1s would be 86,400 buckets: widened to ceil(86,400 / 1,000) = 87 seconds.
			yield* read(1)
			expect(bucketOf(Option.getOrUndefined(series()))).toBe("87")
			// A bucket already coarse enough is kept.
			yield* read(3600)
			expect(bucketOf(Option.getOrUndefined(series()))).toBe("3600")
		}).pipe(Effect.provide(layer))
	})

	it.effect("a verdict filter reads only that verdict's scores", () => {
		const { layer, statements } = layerWith({ llmEvals: true }, (sql) => Effect.succeed(answer(sql)))
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const request = (verdict: "pass" | "fail") =>
				reads.evaluator(
					tenant,
					new GetAiEvaluatorRequest({
						...WINDOW,
						name: "Task completion",
						bucketSeconds: 3600,
						verdict,
					}),
				)
			const failing = yield* request("fail")
			expect(Arr.map(failing.scores, (score) => score.verdict)).toEqual(["fail"])
			const passing = yield* request("pass")
			expect(Arr.map(passing.scores, (score) => score.verdict)).toEqual(["pass", "pass"])
			// Each filtered request reads scores once: the other verdict's read is skipped, not filtered after.
			const scoreReads = Arr.filter(statements, (sql) => Str.includes("ORDER BY timestamp DESC")(sql))
			expect(scoreReads).toHaveLength(2)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads a session's scores by its traces and its session id", () => {
		const { layer, statements } = layerWith({ llmEvals: true }, (sql) =>
			Effect.succeed(
				isResponseSpansRead(sql)
					? []
					: Str.includes("SessionId = 'session-1'")(sql)
						? [
								scoreRow(TRACE_A, "pass", {
									name: "Handoff",
									scope: "session",
									sessionId: "session-1",
								}),
							]
						: [
								scoreRow(TRACE_A, "fail"),
								scoreRow(TRACE_B, "pass", { scoreValue: 0.75, hasScore: 1 }),
							],
			),
		)
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const result = yield* reads.session(
				tenant,
				new GetAiSessionEvaluationsRequest({
					...WINDOW,
					sessionId: "session-1",
					traceIds: [TRACE_A, TRACE_B],
				}),
			)
			expect(Arr.map(result.scores, (score) => score.sessionId)).toEqual([
				"session-1",
				"session-1",
				"session-1",
			])
			// By trace id, session-scope scores by session id, the session's responses: never one OR.
			// With no response in the session, no read by response.
			expect(statements).toHaveLength(3)
			expect(
				Arr.filter(
					statements,
					(sql) =>
						!isResponseSpansRead(sql) && Str.includes(`IN ('${TRACE_A}', '${TRACE_B}')`)(sql),
				),
			).toHaveLength(1)
			expect(Arr.filter(statements, (sql) => Str.includes("Scope = 'session'")(sql))).toHaveLength(1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("files a score that names only a response under the span that returned it", () => {
		const { layer, statements } = layerWith({ llmEvals: true }, (sql) => {
			if (isResponseSpansRead(sql))
				return Effect.succeed([
					{ responseId: "resp_42", traceId: TRACE_B, spanId: "c3c3c3c3c3c3c3c3" },
				])
			// The session's read by response, and the evaluator page's read of its non-failing scores.
			if (Str.includes("IN ('resp_42')")(sql) || Str.includes("scores.verdict != 'fail'")(sql))
				return Effect.succeed([scoreRow("", "pass", { spanId: "", responseId: "resp_42" })])
			return Effect.succeed([])
		})
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const session = yield* reads.session(
				tenant,
				new GetAiSessionEvaluationsRequest({
					...WINDOW,
					sessionId: "session-1",
					traceIds: [TRACE_A, TRACE_B],
				}),
			)
			expect(session.scores).toHaveLength(1)
			expect(session.scores[0]).toMatchObject({
				traceId: TRACE_B,
				spanId: "c3c3c3c3c3c3c3c3",
				sessionId: "session-1",
			})
			const evaluator = yield* reads.evaluator(
				tenant,
				new GetAiEvaluatorRequest({ ...WINDOW, name: "Task completion", bucketSeconds: 3600 }),
			)
			expect(Arr.map(evaluator.scores, (score) => score.traceId)).toEqual([TRACE_B])
			// The evaluator page resolves the response by its id, not by the session's traces.
			expect(
				Arr.some(
					statements,
					(sql) => isResponseSpansRead(sql) && Str.includes("ResponseId IN ('resp_42')")(sql),
				),
			).toBe(true)
		}).pipe(Effect.provide(layer))
	})

	it.effect("still reads a session's scores when its responses cannot be resolved", () => {
		const failure = new WarehouseConfigError({
			message: "budget exceeded",
			pipeName: "aiEvaluationResponseSpans",
			clickhouseType: "TIMEOUT_EXCEEDED",
		})
		const { layer } = layerWith({ llmEvals: true }, (sql) =>
			isResponseSpansRead(sql) ? Effect.fail(failure) : Effect.succeed([scoreRow(TRACE_A, "fail")]),
		)
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const result = yield* reads.session(
				tenant,
				new GetAiSessionEvaluationsRequest({
					...WINDOW,
					sessionId: "session-1",
					traceIds: [TRACE_A],
				}),
			)
			expect(result.scores.length).toBeGreaterThan(0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("reads as empty on a warehouse without the table", () => {
		const missing = new WarehouseConfigError({
			message: "Table default.ai_evaluations does not exist",
			pipeName: "aiEvaluationsSummary",
			clickhouseType: "UNKNOWN_TABLE",
		})
		const { layer } = layerWith({ llmEvals: true }, () => Effect.fail(missing))
		return Effect.gen(function* () {
			const reads = yield* AiEvaluationReadService
			const result = yield* reads.list(tenant, new ListAiEvaluatorsRequest(WINDOW))
			expect(result.evaluators).toEqual([])
		}).pipe(Effect.provide(layer))
	})
})
