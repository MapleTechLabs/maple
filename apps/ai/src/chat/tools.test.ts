/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and whether the run is an autonomous pass travel together: the turn runner closes a
 * pass out itself when `submitted()` stays false, and must never do that to a human follow-up.
 */
import { APP_ORIGIN, AUTONOMOUS_ORIGIN, type ChatTurnOrigin } from "@maple/domain/chat-session"
import { ChatConnectorId, ExternalUserId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { buildDiagnosisCompletion, makeRunUsage, type SubmitDiagnosis } from "./tools"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

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

const build = (sessionId: string, origin: ChatTurnOrigin) =>
	buildDiagnosisCompletion(sessionId, tenantFor(human), origin, submitDiagnosis, makeRunUsage(), MODEL_NAME)

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(`${orgId}:tab`, APP_ORIGIN))
	})

	it("gives a session whose inv- suffix is not an id no completion", () => {
		assert.isUndefined(build(`${orgId}:inv-not-a-uuid`, APP_ORIGIN))
	})

	it("marks the autonomous investigation turn as one the runner must close out", () => {
		const completion = build(INVESTIGATION_SESSION, AUTONOMOUS_ORIGIN)

		assert.isDefined(completion?.toolkit)
		assert.isTrue(completion?.autonomous)
		assert.isFalse(completion?.submitted())
	})

	/**
	 * A human follow-up in the same session gets the same tool and is never closed out: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers the same tool to a human follow-up without treating it as a pass", () => {
		const completion = build(INVESTIGATION_SESSION, APP_ORIGIN)

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
})
