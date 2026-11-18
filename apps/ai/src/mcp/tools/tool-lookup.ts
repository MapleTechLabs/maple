import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { cachedRecoverable } from "@maple/infra/cached-recoverable"
import { Effect, Array as Arr } from "effect"
import { MCP_TOOL_MODULES } from "../tool-modules.generated"
import { surfaceAdmits } from "./types"
import { collectToolDefinitions, type McpToolLookup, type McpToolModule } from "./registry-core"

const modulesByName: ReadonlyMap<string, McpToolModule> = new Map(
	Arr.map(MCP_TOOL_MODULES, (entry) => [entry.name, entry]),
)

/** Registered tools only, in catalog order; aliases resolve through them. */
const registeredModules = Arr.filter(MCP_TOOL_MODULES, (entry) => entry.name === entry.tool)

/** A tool's human title ("Search Repository Checkout"), or undefined for a name outside the registry. */
export const mcpToolTitle = (name: string): string | undefined => {
	const entry = modulesByName.get(name)
	return entry !== undefined && entry.tool === name ? entry.title : undefined
}

/** Imports one tool's module and defines that tool alone, through the registry's `define`. */
const loadDefinition = (entry: McpToolModule) =>
	Effect.promise(entry.load).pipe(
		Effect.map((register) => collectToolDefinitions([register], (name) => name === entry.tool)[0]),
	)

/**
 * A lookup that imports a tool's module the first time a call names it, then keeps it. Built
 * once per executor: a cold `tools/call` pays for its own tool, not the whole registry.
 */
export const makeModuleToolLookup = Effect.gen(function* () {
	const cachedLoads = yield* Effect.forEach(registeredModules, (entry) =>
		// Waiters await a Promise so each resumes in its own request's I/O context; a failed import is retried.
		Effect.map(cachedRecoverable(loadDefinition(entry)), (load) => [entry.tool, load] as const),
	)
	const loaders = new Map(cachedLoads)
	const lookup: McpToolLookup = {
		find: (name) => {
			const entry = modulesByName.get(name)
			return (entry === undefined ? undefined : loaders.get(entry.tool)) ?? Effect.undefined
		},
		namesFor: (surface: McpToolSurface) =>
			Arr.map(
				Arr.filter(registeredModules, (entry) =>
					surfaceAdmits(
						{ name: entry.tool, audience: entry.audience, hints: { readOnly: entry.readOnly } },
						surface,
					),
				),
				(entry) => entry.name,
			),
	}
	return lookup
})
