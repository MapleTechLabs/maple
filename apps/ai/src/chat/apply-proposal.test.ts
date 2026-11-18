/**
 * The two things an approved proposal is refused for before anything is built.
 *
 * The tool check is the one that matters: `MUTATING_TOOL_NAMES` is the last thing standing
 * between an entry in a session's own log and a tool execution under the approver's roles.
 * Reaching it at all means the ruleset that proposes and the allowlist that applies have drifted
 * apart.
 *
 * Both answers are returned before the MCP service graph or a database connection is reached, so
 * this runs without either. Everything past that point needs a real deployment.
 */
import { assert, describe, it } from "vitest"
import type { ChatConnectorOrigin } from "@maple/domain/chat-session"
import { UserId } from "@maple/primitives"
import { Schema } from "effect"
import { applyChatProposal } from "./apply-proposal"

const ADA: ChatConnectorOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "workspace-1",
	externalUserId: "author-1",
	displayName: "Ada",
}

const apply = (overrides: { sessionId?: string; tool?: string; actingUserId?: string }) =>
	applyChatProposal({
		env: {},
		sessionId: "org_1:bot-testchat-c1",
		approver: ADA,
		actingUserId: Schema.decodeSync(UserId)("user_ada"),
		tool: "create_alert_rule",
		input: {},
		...overrides,
	})

describe("refusing an approved proposal before it runs", () => {
	it("refuses a tool that is not approval-gated", async () => {
		// A read-only tool is a real registered tool, so this is the allowlist refusing it rather
		// than the catalog not holding it.
		const result = await apply({ tool: "search_traces" })

		assert.isTrue(result.isError)
		assert.include(result.output, "is not a change Maple applies from an approval")
	})

	it("refuses it for an app approver too, whose own roles do not widen the allowlist", async () => {
		const result = await applyChatProposal({
			env: {},
			sessionId: "org_1:tab-1",
			approver: { kind: "app" },
			tenant: { orgId: "org_1", userId: "user_ada", roles: ["org:admin"], authMode: "clerk" },
			tool: "search_traces",
			input: {},
		})

		assert.isTrue(result.isError)
		assert.include(result.output, "is not a change Maple applies from an approval")
	})

	it("refuses an app approver whose tenant is another org's", async () => {
		const result = await applyChatProposal({
			env: {},
			sessionId: "org_1:tab-1",
			approver: { kind: "app" },
			tenant: { orgId: "org_2", userId: "user_ada", roles: ["org:admin"], authMode: "clerk" },
			tool: "create_alert_rule",
			input: {},
		})

		assert.isTrue(result.isError)
		assert.include(result.output, "another organization")
	})

	it("refuses a connector approval that names no Maple user, and says where a change is made", async () => {
		// `env` is empty: an answer at all means it came back before a runtime or a database was built.
		const unnamed = await applyChatProposal({
			env: {},
			sessionId: "org_1:bot-testchat-c1",
			approver: ADA,
			tool: "create_alert_rule",
			input: {},
		})
		const results = [unnamed, await apply({ actingUserId: "" })]

		for (const result of results) {
			assert.isTrue(result.isError)
			assert.include(result.output, "Maple app")
		}
	})

	it("refuses a conversation whose id names no organization", async () => {
		const result = await apply({ sessionId: "no-org-here" })

		assert.isTrue(result.isError)
		assert.include(result.output, "does not name an organization")
	})
})
