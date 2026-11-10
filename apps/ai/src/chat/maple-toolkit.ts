/**
 * What a chat run is allowed to call.
 *
 * Kept out of `loop/` on purpose: deciding *when* to call a tool is the engine's job, not this
 * module's. Swapping the tool set — a read-only sub-agent, a mode with narrower reach — should not
 * touch control flow at all.
 */
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import type { TenantContext } from "@maple/domain/http"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { buildMapleToolkit, type ToolUiPayload, type UiSource } from "../mcp/tools/llm-tools"

/** The pull request a review session is about, which its diff tools always read. */
export interface SessionPullRequest {
	readonly repository: string
	readonly number: number
}

const PULL_REQUEST_TOOLS: ReadonlySet<string> = new Set(["pr_changed_files", "pr_context", "pr_file_diff"])

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model sees
 * is identical to the ungated case — but it refuses, and `ChatSession.settleProposal` remains the
 * only path that actually mutates.
 */
export const buildChatToolkit = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	ruleset: PermissionRuleset,
	surface: McpToolSurface,
	sessionAttributes?: Readonly<Record<string, string>>,
	onAnswer?: (tool: string, answer: string) => void,
	onUi?: (toolCallId: string, ui: ToolUiPayload, call: UiSource) => void,
	pullRequest?: SessionPullRequest,
) =>
	buildMapleToolkit(executor, tenant, {
		surface,
		...(sessionAttributes === undefined ? undefined : { sessionAttributes }),
		...(onAnswer === undefined ? undefined : { onAnswer }),
		...(onUi === undefined ? undefined : { onUi }),
		...(pullRequest === undefined
			? undefined
			: {
					pinned: (name: string) =>
						PULL_REQUEST_TOOLS.has(name)
							? { repository: pullRequest.repository, number: pullRequest.number }
							: undefined,
				}),
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
