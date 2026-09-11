/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and the fact that calling it *ends the run* travel together. They were once independent
 * inputs, and the chat session supplied only the first, so an autonomous investigation that spent
 * its whole budget answered in prose and filed no diagnosis at all. These pin both halves.
 */
import { InvestigationId, OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { buildDiagnosisCompletion, type SubmitDiagnosis } from "./completion"
import { makeRunUsage } from "../runtime/usage"
import type { ChatTurnTenant as TenantContext } from "@maple/domain/chat-session"

const orgId = Schema.decodeSync(OrgId)("org_test")
const human = Schema.decodeSync(UserId)("user_test")
const internal = Schema.decodeSync(UserId)("internal-service")

const tenantFor = (userId: UserId): TenantContext => ({
	orgId,
	userId,
	roles: [],
	authMode: "self_hosted",
})

const MODEL_NAME = "@cf/test/model"

const INVESTIGATION_ID = Schema.decodeSync(InvestigationId)("00000000-0000-0000-0000-000000000000")

const submitDiagnosis: SubmitDiagnosis = () => Effect.succeed(undefined)

const build = (investigationId: InvestigationId | undefined, userId: UserId) =>
	buildDiagnosisCompletion(investigationId, tenantFor(userId), submitDiagnosis, makeRunUsage(), MODEL_NAME)

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(undefined, human))
	})

	/**
	 * The production bug. The autonomous pass answers *through* `submit_diagnosis` — it is the only
	 * thing that writes `investigations.diagnosis` — so the turn has to close on it.
	 */
	it("closes the autonomous investigation turn on submit_diagnosis", () => {
		const completion = build(INVESTIGATION_ID, internal)

		assert.isDefined(completion?.toolkit)
		assert.isTrue(completion?.required)
	})

	/**
	 * A human follow-up in the same session gets the same tool and does not close on it: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers, without forcing, the same tool to a human follow-up", () => {
		const completion = build(INVESTIGATION_ID, human)

		assert.isDefined(completion?.toolkit)
		assert.isFalse(completion?.required)
	})
})
