/**
 * Code Mode tool catalog — the **pure**, Workers-free description of the Maple
 * tools the Code Mode sandbox can call.
 *
 * Cloudflare Code Mode ([@cloudflare/codemode]) exposes our tools to the model
 * as a typed `maple.*` API the model writes JS against, then runs that JS in a
 * Worker-Loader isolate. The connector that backs that API (`MapleConnector`,
 * Workers-only — it extends `WorkerEntrypoint`) is glue; the actual list of
 * tools, their input schemas, and which ones must pause for approval are derived
 * here from the existing MCP registry so there is a single source of truth.
 *
 * This module deliberately imports **no** `cloudflare:workers` symbols so it can
 * be unit-tested in plain Node (`vitest`) and imported from non-Worker code,
 * mirroring the registry it reads from.
 */
import { mapleToolDefinitions, toInputSchema, type MapleToolDefinition } from "../mcp/tools/registry"
import { MUTATING_TOOL_NAMES } from "../mcp/tools/mutating"

/** One Maple tool as the Code Mode connector sees it (MCP `Tool`-shaped + approval flag). */
export interface CodeModeToolDescriptor {
	/** Registry tool name — the method name the model calls as `maple.<name>(input)`. */
	readonly name: string
	readonly description: string
	/** JSON Schema for the tool input (drives the model-facing TypeScript types). */
	readonly inputSchema: Record<string, unknown>
	/**
	 * When true the runtime PAUSES this call for user approval before it runs
	 * (the `requiresApproval` contract of `@cloudflare/codemode`). Read tools
	 * execute immediately; mutations wait for an approve/reject.
	 */
	readonly requiresApproval: boolean
}

/** Whether a registry tool mutates state and must be gated behind approval. */
export const isMutatingTool = (name: string): boolean => MUTATING_TOOL_NAMES.has(name)

/**
 * Build the Code Mode catalog from the MCP tool registry. Every registry tool is
 * exposed; mutating tools (see {@link MUTATING_TOOL_NAMES}) are flagged
 * `requiresApproval` so the runtime pauses them. `toInputSchema` is the same
 * Effect-Schema → JSON-Schema conversion the MCP server uses, so the model sees
 * identical input shapes whether it calls a tool directly or through Code Mode.
 */
export const buildMapleCodeModeCatalog = (
	definitions: ReadonlyArray<MapleToolDefinition> = mapleToolDefinitions,
): ReadonlyArray<CodeModeToolDescriptor> =>
	definitions.map((definition) => ({
		name: definition.name,
		description: definition.description,
		inputSchema: toInputSchema(definition.schema),
		requiresApproval: isMutatingTool(definition.name),
	}))
