/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and whether the run is an autonomous pass travel together: the turn runner closes a
 * pass out itself when `submitted()` stays false, and must never do that to a human follow-up.
 */
import type { ChatTurnOrigin } from "@maple/domain/chat-session"
import { MAPLE_NATIVE_SESSION_ID_ATTR } from "@maple/domain/gen-ai"
import { ChatConnectorId, ExternalUserId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { buildDiagnosisCompletion, makeRunUsage, SUBMIT_DIAGNOSIS, type SubmitDiagnosis } from "./tools"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"
import { makeRecordingTracer } from "@maple/backend/testing/recording-tracer"

const orgId = Schema.decodeSync(OrgId)("org_test")
const human = Schema.decodeSync(UserId)("user_test")

const CONNECTOR_ORIGIN: ChatTurnOrigin = {
	kind: "connector",
	connectorId: Schema.decodeSync(ChatConnectorId)("testchat"),
	workspaceId: "w1",
	externalUserId: Schema.decodeSync(ExternalUserId)("u-1"),
	displayName: "Ada",
}

const tenantFor = (userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: [],
	authMode: "self_hosted",
})

const MODEL_NAME = "@cf/test/model"

const INVESTIGATION_SESSION = `${orgId}:inv-00000000-0000-0000-0000-000000000000`

const submitDiagnosis: SubmitDiagnosis = () => Effect.succeed(undefined)

const SESSION_ATTRIBUTES = { [MAPLE_NATIVE_SESSION_ID_ATTR]: "session-1" }

const build = (sessionId: string, origin: ChatTurnOrigin) =>
	buildDiagnosisCompletion(
		sessionId,
		tenantFor(human),
		origin,
		submitDiagnosis,
		makeRunUsage(),
		MODEL_NAME,
		false,
		SESSION_ATTRIBUTES,
	)

const sampleSubmission = () => ({
	summary: "Checkout latency doubled after the 14:00 deploy.",
	suspectedCause: "Regression in the payments client connection pool",
	severityAssessment: "high",
	affectedScope: "checkout-api, p95 across all regions",
	evidence: [{ traceIds: ["abc123def456"], note: "Pool saturation in the failing traces" }],
	suggestedActions: ["Roll back the 14:00 deploy"],
	confidence: "high",
})

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(`${orgId}:tab`, { kind: "app" }))
	})

	it("gives a session whose inv- suffix is not an id no completion", () => {
		assert.isUndefined(build(`${orgId}:inv-not-a-uuid`, { kind: "app" }))
	})

	it("marks the autonomous investigation turn as one the runner must close out", () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "autonomous" })

		assert.isDefined(completion?.toolkit)
		assert.isTrue(completion?.autonomous)
		assert.isFalse(completion?.submitted())
	})

	/**
	 * A human follow-up in the same session gets the same tool and is never closed out: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers the same tool to a human follow-up without treating it as a pass", () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "app" })

		assert.isDefined(completion?.toolkit)
		assert.isFalse(completion?.autonomous)
	})

	/**
	 * This tool is merged into the run's toolkit *outside* the permission ruleset, so the approval
	 * gate does not reach it — and it writes: a report row, and the investigation's status. A
	 * channel is not where a diagnosis gets settled, so a connector origin is refused here by name.
	 */
	it("gives a connector turn no diagnosis tool, even on an investigation session", () => {
		assert.isUndefined(build(INVESTIGATION_SESSION, CONNECTOR_ORIGIN))
	})

	/**
	 * The arguments ARE the report, and the engine's `execute_tool` span carries no content of its
	 * own: registered without `toolHandlersWithContent`, every diagnosis in Agent Sessions rendered
	 * as a tool call with no arguments and no result.
	 */
	it("records the report and the result on the tool's span", async () => {
		const completion = build(INVESTIGATION_SESSION, { kind: "autonomous" })
		assert.isDefined(completion)
		const { spans, tracer } = makeRecordingTracer()

		await Effect.runPromise(
			completion!.handlers[SUBMIT_DIAGNOSIS](sampleSubmission(), {} as never).pipe(
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
