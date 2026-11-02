#!/usr/bin/env bun
/**
 * Renders `src/mcp/tool-descriptors.generated.ts`, the public `tools/list` the MCP server
 * registers without importing the registry. `tool-descriptors.test.ts` fails when it drifts.
 *
 *   bun run --cwd apps/ai mcp:tools            # write
 *   bun run --cwd apps/ai mcp:tools --check    # verify
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import { listMcpTools } from "@/mcp/tool-catalog"
import { renderToolDescriptorsModule } from "@/mcp/tool-descriptors-render"

const OUTPUT = resolve(import.meta.dirname, "../src/mcp/tool-descriptors.generated.ts")

const rendered = renderToolDescriptorsModule(await Effect.runPromise(listMcpTools))
const existing = existsSync(OUTPUT) ? readFileSync(OUTPUT, "utf8") : ""

if (process.argv.includes("--check")) {
	if (existing !== rendered) {
		console.error("MCP tool descriptors are out of date. Run `bun run --cwd apps/ai mcp:tools`.")
		process.exit(1)
	}
	console.log("MCP tool descriptors are up to date.")
} else {
	writeFileSync(OUTPUT, rendered)
	console.log(`Wrote ${OUTPUT}.`)
}
