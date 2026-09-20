/**
 * `buildDiagnosisCompletion` — the one value an investigation turn answers through.
 *
 * The tool and whether the run is an autonomous pass travel together: the turn runner closes a
 * pass out itself when `submitted()` stays false, and must never do that to a human follow-up.
 */
import { CHAT_BOT_USER_ID } from "@maple/domain/chat-session"
import { OrgId, UserId } from "@maple/domain/primitives"
import { Effect, Schema } from "effect"
import { assert, describe, it } from "vitest"
import { buildDiagnosisCompletion, makeRunUsage, type SubmitDiagnosis } from "./tools"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

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

const INVESTIGATION_SESSION = `${orgId}:inv-00000000-0000-0000-0000-000000000000`

const submitDiagnosis: SubmitDiagnosis = () => Effect.succeed(undefined)

const build = (sessionId: string, userId: UserId) =>
	buildDiagnosisCompletion(sessionId, tenantFor(userId), submitDiagnosis, makeRunUsage(), MODEL_NAME)

describe("buildDiagnosisCompletion", () => {
	it("gives an ordinary conversation no completion at all", () => {
		assert.isUndefined(build(`${orgId}:tab`, human))
	})

	it("gives a session whose inv- suffix is not an id no completion", () => {
		assert.isUndefined(build(`${orgId}:inv-not-a-uuid`, human))
	})

	it("marks the autonomous investigation turn as one the runner must close out", () => {
		const completion = build(INVESTIGATION_SESSION, internal)

		assert.isDefined(completion?.toolkit)
		assert.isTrue(completion?.autonomous)
		assert.isFalse(completion?.submitted())
	})

	/**
	 * A human follow-up in the same session gets the same tool and is never closed out: it may file
	 * a superseding diagnosis, but "what did you mean by the pool?" must be answerable in prose.
	 */
	it("offers the same tool to a human follow-up without treating it as a pass", () => {
		const completion = build(INVESTIGATION_SESSION, human)

		assert.isDefined(completion?.toolkit)
		assert.isFalse(completion?.autonomous)
	})

	/**
	 * This tool is merged into the run's toolkit *outside* the permission ruleset, so the bot's
	 * `READ_ONLY_RULESET` does not withhold it — and it writes: a report row, and the
	 * investigation's status. The bot answers into a channel anyone can post in, so it is refused
	 * here by actor, the one signal a session id built elsewhere cannot forge.
	 */
	it("gives the chat-bot actor no diagnosis tool, even on an investigation session", () => {
		assert.isUndefined(build(INVESTIGATION_SESSION, CHAT_BOT_USER_ID))
	})
})
