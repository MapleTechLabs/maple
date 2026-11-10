/**
 * `submit_diagnosis`, the one value an investigation turn answers through. Which session gets it is
 * `sessionOf`'s answer (`agents.test.ts`); who gets it is decided here, by the origin.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { MAPLE_NATIVE_SESSION_ID_ATTR } from "@maple/domain/gen-ai"
import { ChatConnectorId, ExternalUserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"
import { type CompletionRun, SUBMIT_DIAGNOSIS } from "./completion"
import { diagnosisCompletion, type SubmitDiagnosis } from "./investigation"
import { makeRunUsage } from "./usage"

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: Schema.decodeSync(ChatConnectorId)("testchat"),
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

const SESSION_ATTRIBUTES = { [MAPLE_NATIVE_SESSION_ID_ATTR]: "session-1" }

const runFor = (partial = false): CompletionRun => ({
	turnId: "msg-1",
	usage: makeRunUsage(),
	modelName: "@cf/test/model",
	partial,
	sessionAttributes: SESSION_ATTRIBUTES,
})

const submitDiagnosis: SubmitDiagnosis = () => Effect.undefined

const build = (origin: ChatTurnOrigin) => diagnosisCompletion(origin, submitDiagnosis)?.(runFor())

const sampleSubmission = () => ({
	summary: "Checkout latency doubled after the 14:00 deploy.",
	suspectedCause: "Regression in the payments client connection pool",
	severityAssessment: "high",
	affectedScope: "checkout-api, p95 across all regions",
	evidence: [{ traceIds: ["abc123def456"], note: "Pool saturation in the failing traces" }],
	suggestedActions: ["Roll back the 14:00 deploy"],
	confidence: "high",
})

describe("diagnosisCompletion", () => {
	/**
	 * A human follow-up in the same session gets the same tool and is never closed out: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers the tool to the unattended pass and to a human follow-up alike", () => {
		const pass = build({ kind: "autonomous" })
		assert.equal(pass?.tool, SUBMIT_DIAGNOSIS)
		assert.isFalse(pass?.submitted())
		assert.equal(build({ kind: "app" })?.tool, SUBMIT_DIAGNOSIS)
	})

	/**
	 * This tool is merged into the run's toolkit *outside* the permission ruleset, so the approval
	 * gate does not reach it — and it writes: a report row, and the investigation's status. A
	 * channel is not where a diagnosis gets settled, so a connector origin is refused here by name.
	 */
	it("gives a connector turn no diagnosis tool, even on an investigation session", () => {
		assert.isUndefined(build(CONNECTOR_ORIGIN))
	})

	/**
	 * The arguments ARE the report, and the engine's `execute_tool` span carries no content of its
	 * own: registered without `toolHandlersWithContent`, every diagnosis in Agent Sessions rendered
	 * as a tool call with no arguments and no result.
	 */
	it("records the report and the result on the tool's span", async () => {
		const completion = build({ kind: "autonomous" })
		assert.isDefined(completion)
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			completion.handlers[SUBMIT_DIAGNOSIS](sampleSubmission()).pipe(
				Effect.withSpan(`execute_tool ${SUBMIT_DIAGNOSIS}`),
				Effect.withTracer(tracer),
			),
		)

		const attributes = spans[0]?.attributes
		assert.include(String(attributes?.get("gen_ai.tool.call.arguments")), "Checkout latency doubled")
		assert.include(String(attributes?.get("gen_ai.tool.call.result")), "Diagnosis recorded.")
		assert.include(String(attributes?.get("gen_ai.tool.description")), "structured diagnosis")
		// The same session identity every other tool span carries, so the call files under its turn.
		assert.equal(attributes?.get(MAPLE_NATIVE_SESSION_ID_ATTR), "session-1")
	})
})
