import type { McpToolDescriptor } from "@maple/domain/mcp-tool-contract"
import { Effect } from "effect"

/**
 * The tool catalog, loaded on the first call that needs it rather than with this module.
 *
 * It is the largest chunk in the Worker, and most cold `/mcp` requests (`initialize`, the
 * resource and prompt lists, 401s) never touch a tool. The dynamic import also breaks the
 * registry -> tool -> chat/tools -> dispatcher cycle, so no module can observe a half-built catalog.
 */
export const loadRegistry = Effect.promise(() => import("./tools/registry"))

const toolDescriptors = ({
	inputSchemaOf,
	mapleToolCatalogFor,
	toOutputSchema,
}: typeof import("./tools/registry")): ReadonlyArray<McpToolDescriptor> =>
	mapleToolCatalogFor("mcp").map((definition) => ({
		name: definition.name,
		// Current spec reads the top-level `title`; Claude's directory and older clients read `annotations.title`.
		title: definition.title,
		description: definition.description,
		inputSchema: inputSchemaOf(definition),
		...(definition.outputSchema === undefined
			? undefined
			: { outputSchema: toOutputSchema(definition.outputSchema) }),
		...(definition.hints === undefined
			? undefined
			: {
					annotations: {
						title: definition.title,
						readOnlyHint: definition.hints.readOnly,
						// The protocol defaults both of these to true; every Maple tool states them.
						destructiveHint: !definition.hints.readOnly && definition.hints.destructive === true,
						idempotentHint: definition.hints.readOnly || definition.hints.idempotent === true,
						openWorldHint: definition.hints.openWorld === true,
					},
				}),
	}))

/** The public transport's `tools/list`: the catalog minus every `internal` tool. Callers cache it. */
export const listMcpTools = Effect.map(loadRegistry, toolDescriptors)
