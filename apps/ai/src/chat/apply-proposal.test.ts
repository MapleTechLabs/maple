/**
 * The two things an approved proposal is refused for before anything is built.
 *
 * The tool check is the one that matters: `connectorApprovalTenant` hands the executor
 * `org:admin`, so `MUTATING_TOOL_NAMES` is the last thing standing between an entry in a session's
 * own log and an org-admin tool execution. Reaching it at all means the ruleset that proposes and
 * the allowlist that applies have drifted apart.
 *
 * Both answers are returned before the MCP service graph or a database connection is reached, so
 * this runs without either. Everything past that point needs a real deployment.
 */
import { assert, describe, it } from "vitest"
import type { ChatConnectorOrigin } from "@maple/domain/chat-session"
import { applyChatProposal } from "./apply-proposal"

const ADA: ChatConnectorOrigin = {
	kind: "connector",
	connectorId: "testchat",
	workspaceId: "workspace-1",
	externalUserId: "author-1",
	displayName: "Ada",
}

const apply = (overrides: { sessionId?: string; tool?: string }) =>
	applyChatProposal({
		env: {},
		sessionId: "org_1:bot-testchat-c1",
		approver: ADA,
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

	it("refuses a conversation whose id names no organization", async () => {
		const result = await apply({ sessionId: "no-org-here" })

		assert.isTrue(result.isError)
		assert.include(result.output, "does not name an organization")
	})
})
