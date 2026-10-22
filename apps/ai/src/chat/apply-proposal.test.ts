/**
 * What an approved proposal is refused for before anything is built.
 *
 * A connector approval with no linked Maple user is refused outright, and `MUTATING_TOOL_NAMES`
 * keeps anything but an approval-gated tool from running. Reaching the latter at all means the
 * ruleset that proposes and the allowlist that applies have drifted apart.
 *
 * Both answers are returned before the MCP service graph or a database connection is reached, so
 * this runs without either. Everything past that point needs a real deployment.
 */
import { assert, describe, it } from "vitest"
import type { ChatConnectorOrigin } from "@maple/domain/chat-session"
import { UserId } from "@maple/domain/primitives"
import { Schema } from "effect"
import { applyChatProposal, LINK_REQUIRED } from "./apply-proposal"

const ADA_USER = Schema.decodeSync(UserId)("user_ada")

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
		actingUserId: ADA_USER,
		...overrides,
	})

describe("refusing an approved proposal before it runs", () => {
	it("refuses a connector approver with no linked Maple user", async () => {
		// A caller on an older contract can still omit the link; it must not run as anyone.
		const unlinked = {
			env: {},
			sessionId: "org_1:bot-testchat-c1",
			approver: ADA,
			tool: "create_alert_rule",
			input: {},
			actingUserId: ADA_USER,
		}
		Reflect.deleteProperty(unlinked, "actingUserId")
		const result = await applyChatProposal(unlinked)

		assert.isTrue(result.isError)
		assert.strictEqual(result.output, LINK_REQUIRED)
	})

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

	it("refuses a conversation whose id names no organization", async () => {
		const result = await apply({ sessionId: "no-org-here" })

		assert.isTrue(result.isError)
		assert.include(result.output, "does not name an organization")
	})
})
