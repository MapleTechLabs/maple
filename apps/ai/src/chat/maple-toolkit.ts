/**
 * What a chat run is allowed to call.
 *
 * Deciding *when* to call a tool is the engine's job, not this module's. Swapping the tool set (a
 * read-only sub-agent, a mode with narrower reach) should not touch control flow at all.
 */
import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import type { TenantContext } from "@maple/domain/http"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import type { McpToolExecutorApi } from "../mcp/dispatcher"
import { buildMapleToolkit, type ToolUiPayload, type UiSource } from "../mcp/tools/llm-tools"

/** The pull request a review or reply session is about: the one its tools read, whatever the model names. */
export interface SessionPullRequest {
	readonly repository: string
	readonly number: number
}

/**
 * What a session about a pull request may read. `unreadable` is one whose pull request could not
 * be looked up: it is offered no tool that names a repository, rather than every repository.
 */
export type SessionRepositoryScope = SessionPullRequest | "unreadable"

const PULL_REQUEST_TOOLS: ReadonlySet<string> = new Set(["pr_changed_files", "pr_context", "pr_file_diff"])

/** Tools that read whichever connected repository their `repository` argument names. */
const REPOSITORY_TOOLS: ReadonlySet<string> = new Set([
	"read_source_file",
	"sandbox_exec",
	"sandbox_grep",
	"sandbox_list_files",
	"sandbox_read_file",
	"search_source_code",
])

const namesRepository = (tool: string): boolean => PULL_REQUEST_TOOLS.has(tool) || REPOSITORY_TOOLS.has(tool)

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
	pullRequest?: SessionRepositoryScope,
) =>
	buildMapleToolkit(executor, tenant, {
		surface,
		...(sessionAttributes === undefined ? undefined : { sessionAttributes }),
		...(onAnswer === undefined ? undefined : { onAnswer }),
		...(onUi === undefined ? undefined : { onUi }),
		...(pullRequest === undefined || pullRequest === "unreadable"
			? undefined
			: {
					pinned: (name: string) =>
						PULL_REQUEST_TOOLS.has(name)
							? { repository: pullRequest.repository, number: pullRequest.number }
							: REPOSITORY_TOOLS.has(name)
								? { repository: pullRequest.repository }
								: undefined,
				}),
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) =>
			evaluatePermission(ruleset, name) !== "deny" &&
			!(pullRequest === "unreadable" && namesRepository(name)),
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
