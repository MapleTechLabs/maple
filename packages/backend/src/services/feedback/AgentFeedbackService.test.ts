import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Order, Result, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { AgentFeedbackService } from "./AgentFeedbackService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_feedback")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const USER = Schema.decodeSync(UserId)("user_feedback")

const INTERNAL_ORG = Schema.decodeSync(OrgId)("org_maple_internal")

const provideWith =
	(env: Record<string, unknown>) =>
	<A, E>(effect: Effect.Effect<A, E, AgentFeedbackService>) =>
		effect.pipe(
			Effect.provide(
				AgentFeedbackService.layer.pipe(
					Layer.provide(Layer.mergeAll(createTestDb(trackedDbs).layer, testEnv(env))),
				),
			),
		)

const provide = provideWith({ MAPLE_INTERNAL_ORG_ID: INTERNAL_ORG })

describe("AgentFeedbackService", () => {
	it.effect("stores the kind, agent and reason, and normalizes blank optionals to null", () =>
		provide(
			Effect.gen(function* () {
				const service = yield* AgentFeedbackService
				const feedback = yield* service.submit(ORG, USER, {
					kind: "bug",
					impact: "degraded",
					summary: "  search_traces ignores environment  ",
					reason: "Needed production-only traces.",
					details: "   ",
					relatedTo: "search_traces",
					agent: { type: "coding_agent", name: "claude-code", model: "claude-opus-5-5" },
					source: "mcp",
				})
				assert.strictEqual(feedback.kind, "bug")
				assert.strictEqual(feedback.impact, "degraded")
				assert.strictEqual(feedback.summary, "search_traces ignores environment")
				assert.strictEqual(feedback.details, null)
				assert.strictEqual(feedback.relatedTo, "search_traces")
				assert.deepStrictEqual(feedback.agent, {
					type: "coding_agent",
					name: "claude-code",
					model: "claude-opus-5-5",
					version: null,
				})
				assert.strictEqual(feedback.source, "mcp")
			}),
		),
	)

	it.effect("lists newest first, scoped to the org, with offset paging", () =>
		provide(
			Effect.gen(function* () {
				const service = yield* AgentFeedbackService
				const submit = (orgId: OrgId, summary: string) =>
					service.submit(orgId, USER, {
						kind: "feature_request",
						summary,
						reason: "Missing capability",
						agent: { type: "autonomous_agent" },
						source: "api",
					})
				yield* submit(ORG, "first")
				yield* TestClock.adjust("1 second")
				yield* submit(ORG, "second")
				yield* submit(OTHER_ORG, "elsewhere")

				const all = yield* service.list(ORG, { limit: 10, offset: 0 })
				assert.deepStrictEqual(
					Arr.map(all, (row) => row.summary),
					["second", "first"],
				)
				const page = yield* service.list(ORG, { limit: 1, offset: 1 })
				assert.deepStrictEqual(
					Arr.map(page, (row) => row.summary),
					["first"],
				)
			}),
		),
	)

	describe("triage", () => {
		const seed = Effect.gen(function* () {
			const service = yield* AgentFeedbackService
			yield* service.submit(ORG, USER, {
				kind: "bug",
				impact: "blocking",
				summary: "run_sql rejects a valid query",
				reason: "Needed a count",
				relatedTo: "run_sql",
				agent: { type: "coding_agent" },
				source: "mcp",
			})
			yield* service.submit(ORG, USER, {
				kind: "improvement",
				summary: "runXsql decoy",
				reason: "Matches run_sql only if `_` is a wildcard",
				relatedTo: "runXsql",
				agent: { type: "coding_agent" },
				source: "mcp",
			})
			yield* TestClock.adjust("1 hour")
			yield* service.submit(OTHER_ORG, USER, {
				kind: "documentation",
				impact: "minor",
				summary: "search_traces description is vague",
				reason: "Guessed the filter",
				relatedTo: "Search_Traces",
				agent: { type: "chat_assistant" },
				source: "api",
			})
			return service
		})

		it.effect("reads every org's feedback, newest first, for Maple's internal org", () =>
			provide(
				Effect.gen(function* () {
					const service = yield* seed
					const all = yield* service.triage(INTERNAL_ORG, { limit: 10 })
					assert.deepStrictEqual(
						Arr.map(all, (row) => row.orgId),
						[OTHER_ORG, ORG, ORG],
					)
				}),
			),
		)

		it.effect("narrows by kind, impact, since, org and a case-insensitive related_to", () =>
			provide(
				Effect.gen(function* () {
					const service = yield* seed
					const summaries = (filter: Parameters<typeof service.triage>[1]) =>
						service
							.triage(INTERNAL_ORG, filter)
							.pipe(Effect.map((rows) => Arr.map(rows, (row) => row.summary)))
					assert.deepStrictEqual(yield* summaries({ limit: 10, kind: "bug" }), [
						"run_sql rejects a valid query",
					])
					assert.deepStrictEqual(yield* summaries({ limit: 10, impact: "minor" }), [
						"search_traces description is vague",
					])
					assert.deepStrictEqual(yield* summaries({ limit: 10, relatedTo: "search_" }), [
						"search_traces description is vague",
					])
					// `_` is a literal here, not a LIKE wildcard: the `runXsql` decoy stays out.
					assert.deepStrictEqual(yield* summaries({ limit: 10, relatedTo: "run_sql" }), [
						"run_sql rejects a valid query",
					])
					assert.deepStrictEqual(
						Arr.sort(yield* summaries({ limit: 10, orgId: ORG }), Order.String),
						["runXsql decoy", "run_sql rejects a valid query"],
					)
					const newest = yield* service.triage(INTERNAL_ORG, { limit: 1 })
					assert.deepStrictEqual(yield* summaries({ limit: 10, sinceMs: newest[0]?.createdAtMs }), [
						"search_traces description is vague",
					])
				}),
			),
		)

		it.effect("refuses any other org, including one that sent feedback", () =>
			provide(
				Effect.gen(function* () {
					const service = yield* seed
					const result = yield* Effect.result(service.triage(ORG, { limit: 10 }))
					assert.isTrue(Result.isFailure(result))
					if (Result.isFailure(result)) {
						assert.strictEqual(
							result.failure._tag,
							"@maple/http/errors/AgentFeedbackTriageForbiddenError",
						)
					}
				}),
			),
		)

		it.effect("refuses every org while MAPLE_INTERNAL_ORG_ID is unset", () =>
			provideWith({})(
				Effect.gen(function* () {
					const service = yield* seed
					const result = yield* Effect.result(service.triage(INTERNAL_ORG, { limit: 10 }))
					assert.isTrue(Result.isFailure(result))
				}),
			),
		)
	})
})
