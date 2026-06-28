import type { ToolDefinition } from "@flue/runtime"
import { buildApiDeclaration, RUN_CODE_TOOL_NAME, type CodeModeToolSpec, type JsonSchema } from "@maple/codemode"
import { baseToolName } from "../mcp.ts"

export interface CodeModeApi {
	/** The `declare const maple: { ... }` surface injected into the system prompt. */
	readonly declaration: string
	/** Base tool name -> the (approval-gated) Flue tool `execute`, the RPC backend. */
	readonly dispatch: ReadonlyMap<string, ToolDefinition["execute"]>
	/** Base names exposed to code mode (for telemetry / debugging). */
	readonly toolNames: ReadonlyArray<string>
}

const isJsonSchema = (p: unknown): p is JsonSchema =>
	typeof p === "object" && p !== null && ("properties" in p || "type" in p)

/**
 * Project the connected (already approval-gated) MCP tools into a Code Mode API:
 * the `maple.*` TypeScript declaration for the prompt plus a name->execute
 * dispatch map. Built from the SAME gated array the direct-tool path uses, so a
 * mutating `maple.create_dashboard(...)` call runs the proposal-returning
 * `execute` and never mutates — approval gating is inherited for free.
 */
export const buildCodeModeApi = (tools: ReadonlyArray<ToolDefinition>): CodeModeApi => {
	const dispatch = new Map<string, ToolDefinition["execute"]>()
	const specs: CodeModeToolSpec[] = []
	for (const tool of tools) {
		const name = baseToolName(tool.name)
		// Never expose run_code to itself (the chat path appends run_code after this
		// runs, so this is defense-in-depth against a future ordering change).
		if (name === RUN_CODE_TOOL_NAME || dispatch.has(name)) continue
		dispatch.set(name, tool.execute)
		specs.push({
			name,
			description: tool.description,
			parameters: isJsonSchema(tool.parameters) ? tool.parameters : undefined,
		})
	}
	return { declaration: buildApiDeclaration(specs), dispatch, toolNames: specs.map((s) => s.name) }
}
