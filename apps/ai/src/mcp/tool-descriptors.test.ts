import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { listMcpTools } from "./tool-catalog"
import { MCP_TOOL_DESCRIPTORS } from "./tool-descriptors.generated"

describe("MCP_TOOL_DESCRIPTORS", () => {
	// The MCP server lists these instead of building the catalog, so they must be what the
	// registry would list today: an Effect upgrade that moves a JSON Schema fails here.
	it.effect("is the tools/list the registry generates, byte for byte", () =>
		Effect.gen(function* () {
			const generated = yield* listMcpTools
			expect(
				JSON.stringify(MCP_TOOL_DESCRIPTORS),
				"Stale descriptors: run `bun run --cwd apps/ai mcp:tools`",
			).toBe(JSON.stringify(generated))
		}),
	)
})
