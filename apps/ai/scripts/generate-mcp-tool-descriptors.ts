#!/usr/bin/env bun
/**
 * Renders `src/mcp/tool-descriptors.generated.ts`, the public `tools/list` the MCP server
 * registers without importing the registry, and `src/mcp/tool-modules.generated.ts`, the module
 * each tool name loads on its first call. `tool-descriptors.test.ts` and `tool-lookup.test.ts`
 * fail when they drift.
 *
 *   bun run --cwd apps/ai mcp:tools            # write
 *   bun run --cwd apps/ai mcp:tools --check    # verify
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { Effect } from "effect"
import {
	listMcpTools,
	renderToolDescriptorsModule,
	renderToolModulesModule,
	type ToolModuleSource,
} from "@/mcp/tool-descriptors-render"
import { mapleToolCatalog } from "@/mcp/tools/registry"
import { TOOL_NAME_ALIASES } from "@/mcp/tools/tool-name-aliases"
import { ignoreFamily, type McpToolRegistrar } from "@/mcp/tools/types"

const DESCRIPTORS = resolve(import.meta.dirname, "../src/mcp/tool-descriptors.generated.ts")
const MODULES = resolve(import.meta.dirname, "../src/mcp/tool-modules.generated.ts")
const TOOLS_DIR = resolve(import.meta.dirname, "../src/mcp/tools")

/** Which module and registration function defines each tool, found by running every registrar. */
const findToolModules = async (): Promise<
	ReadonlyMap<string, Pick<ToolModuleSource, "module" | "register">>
> => {
	const found = new Map<string, Pick<ToolModuleSource, "module" | "register">>()
	const files = readdirSync(TOOLS_DIR).filter((file) => file.endsWith(".ts") && !file.endsWith(".test.ts"))
	for (const file of files.sort()) {
		const module = file.slice(0, -".ts".length)
		const exports: Record<string, unknown> = await import(resolve(TOOLS_DIR, file))
		for (const [register, value] of Object.entries(exports)) {
			if (!/^register\w+Tools?$/.test(register) || typeof value !== "function") continue
			const record = (name: string) => {
				const existing = found.get(name)
				if (existing !== undefined) {
					throw new Error(`${name} is registered by both ${existing.module} and ${module}`)
				}
				found.set(name, { module, register })
			}
			const registrar: McpToolRegistrar = {
				define: (spec) => record(spec.name),
				family: (spec) => {
					record(spec.name)
					return ignoreFamily()
				},
			}
			value(registrar)
		}
	}
	return found
}

const modules = await findToolModules()
const sourceOf = (name: string, tool: string): ToolModuleSource => {
	const entry = mapleToolCatalog.find((candidate) => candidate.name === tool)
	const location = modules.get(tool)
	if (entry === undefined || location === undefined) {
		throw new Error(`No module registers ${tool}`)
	}
	return {
		name,
		tool,
		title: entry.title,
		audience: entry.audience,
		readOnly: entry.hints.readOnly,
		permission: entry.permission,
		...location,
	}
}

const outputs = [
	{ path: DESCRIPTORS, rendered: renderToolDescriptorsModule(await Effect.runPromise(listMcpTools)) },
	{
		path: MODULES,
		rendered: renderToolModulesModule([
			...mapleToolCatalog.map((entry) => sourceOf(entry.name, entry.name)),
			...Object.entries(TOOL_NAME_ALIASES).map(([alias, target]) => sourceOf(alias, target.tool)),
		]),
	},
]

if (process.argv.includes("--check")) {
	const stale = outputs.filter(
		({ path, rendered }) => (existsSync(path) ? readFileSync(path, "utf8") : "") !== rendered,
	)
	if (stale.length > 0) {
		console.error("MCP tool descriptors are out of date. Run `bun run --cwd apps/ai mcp:tools`.")
		process.exit(1)
	}
	console.log("MCP tool descriptors are up to date.")
} else {
	for (const { path, rendered } of outputs) {
		writeFileSync(path, rendered)
		console.log(`Wrote ${path}.`)
	}
}
