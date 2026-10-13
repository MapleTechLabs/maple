import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { AgentFeedbackService } from "./AgentFeedbackService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_feedback")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_other")
const USER = Schema.decodeUnknownSync(UserId)("user_feedback")

const provide = <A, E>(effect: Effect.Effect<A, E, AgentFeedbackService>) =>
	effect.pipe(
		Effect.provide(AgentFeedbackService.layer.pipe(Layer.provide(createTestDb(trackedDbs).layer))),
	)

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
					all.map((row) => row.summary),
					["second", "first"],
				)
				const page = yield* service.list(ORG, { limit: 1, offset: 1 })
				assert.deepStrictEqual(
					page.map((row) => row.summary),
					["first"],
				)
			}),
		),
	)
})
