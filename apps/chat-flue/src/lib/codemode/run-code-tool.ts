import type { ToolDefinition } from "@flue/runtime"
import { formatRunResult, RUN_CODE_TOOL_NAME, type CodeProposal, type RpcCallResult } from "@maple/codemode"
import { parseToolProposal } from "../approval.ts"
import type { ChatFlueEnv } from "../env.ts"
import type { CodeModeApi } from "./api-gen.ts"

/**
 * Build the `maple.<name>(input)` dispatch for a code run: look up the gated
 * tool `execute`, run it, and — because mutating tools' gated execute returns a
 * proposal marker instead of mutating — collect any proposal via `onProposal`
 * while still returning its value to the model. Unknown tools become error
 * values so the model self-corrects. Extracted (and free of the Workers-only
 * sandbox import) so the approval-collection logic is unit-testable.
 */
export const createCodeModeDispatch = (
	dispatch: CodeModeApi["dispatch"],
	onProposal: (proposal: CodeProposal) => void,
) => {
	return async (name: string, input: unknown): Promise<RpcCallResult> => {
		const execute = dispatch.get(name)
		if (!execute) {
			return { ok: false, error: { name: "UnknownTool", message: `maple.${name} is not available` } }
		}
		const value = await execute((input ?? {}) as Record<string, unknown>)
		const proposal = parseToolProposal(value)
		if (proposal) onProposal({ tool: proposal.tool, input: proposal.input })
		return { ok: true, value }
	}
}

const DESCRIPTION = `Run a JavaScript snippet against Maple's observability data using the \`maple\` API declared in the system prompt. Prefer this for any multi-step investigation: call several \`maple.*\` tools, filter/aggregate their results in code, and \`console.log\`/\`return\` only what matters — one call instead of many round-trips. Imports and network are disabled. \`await maple.<tool>(input)\` returns the tool's text output and throws on failure (wrap in try/catch to keep going). Mutating tools only PROPOSE a change for the user to approve.`

/**
 * A single local Flue tool that executes model-written code in a fresh
 * Cloudflare Dynamic Worker isolate (network blocked), bridging each
 * `maple.<tool>(input)` call back to the connected MCP tools via the
 * supervisor RPC. Mutating calls run the approval-gated `execute`, so they
 * return a proposal marker instead of mutating; the proposals are collected and
 * surfaced to the web client as a `proposed_batch` envelope.
 */
export const createRunCodeTool = (env: ChatFlueEnv, api: CodeModeApi): ToolDefinition => ({
	name: RUN_CODE_TOOL_NAME,
	description: DESCRIPTION,
	parameters: {
		type: "object",
		properties: {
			code: {
				type: "string",
				description:
					"A JavaScript snippet. Use `await maple.<tool>(input)`, `console.log(...)`, and `return`. No imports, no network, no type annotations.",
			},
		},
		required: ["code"],
	},
	execute: async (args) => {
		const code = typeof args?.code === "string" ? args.code : ""
		const loader = env.LOADER
		if (!loader) {
			return "Code mode is unavailable (no sandbox runtime is bound). Call the mcp__maple__* tools directly instead."
		}
		if (!code.trim()) {
			return "No code provided. Pass a `code` string that uses the `maple` API."
		}

		const proposals: CodeProposal[] = []
		const dispatch = createCodeModeDispatch(api.dispatch, (p) => proposals.push(p))

		// Dynamic import: the sandbox driver pulls in `cloudflare:workers`, so keep
		// it out of this module's static graph (importable by Node-based tests).
		const { runCodeInSandbox } = await import("@maple/codemode/sandbox")
		const result = await runCodeInSandbox(loader, {
			id: `maple-codemode-${crypto.randomUUID()}`,
			code,
			dispatch,
		})
		return formatRunResult(result, proposals)
	},
})
