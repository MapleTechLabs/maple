import { evaluatePermission, type PermissionRuleset } from "@maple/domain/permission"
import type { ToolExecutorApi } from "./tool-executor"
import { buildMapleToolkit } from "./llm-tools"

/**
 * All Maple tools, with mutating ones gated.
 *
 * A gated tool still carries a real handler (rather than being omitted) so the schema the model sees
 * is identical to the ungated case — but it refuses, and `POST /internal/chat/apply` remains the
 * only path that actually mutates.
 */
export const buildAgentToolkit = (executor: ToolExecutorApi, ruleset: PermissionRuleset) =>
	buildMapleToolkit(executor, {
		// `deny` means the model never sees the tool. That is a stronger guarantee than refusing the
		// call afterwards, and it is free — an unoffered tool cannot be called.
		include: (name) => evaluatePermission(ruleset, name) !== "deny",
		gate: (name) => evaluatePermission(ruleset, name) === "ask",
	})
