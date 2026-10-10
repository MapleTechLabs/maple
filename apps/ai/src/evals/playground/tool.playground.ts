/**
 * One MCP tool call against a fixture world, for agents testing the tools by using them: the real
 * registry, decoding and rendering, with only the warehouse faked. Driven by
 * `scripts/tool-playground.sh`, which passes the request in the environment:
 *
 *   PLAYGROUND_CMD    catalog | schema | call
 *   PLAYGROUND_TOOL   the tool, for schema and call
 *   PLAYGROUND_ARGS   JSON arguments, for call
 *   PLAYGROUND_OUT    where the text goes (what the model would read)
 *   PLAYGROUND_LOG    optional JSONL file; every call is appended for grading
 */
import { appendFileSync, writeFileSync } from "node:fs"
import { afterAll, beforeAll, it } from "vitest"
import { installFakeWarehouse, restoreWarehouse } from "@/mcp/__evals__/fake-warehouse"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"
import { infraFixtureRules } from "@/mcp/__evals__/infra-world"
import { inputSchemaOf, mapleToolCatalog } from "@/mcp/tools/registry"

const env = process.env
const out = env.PLAYGROUND_OUT ?? "/tmp/maple-tool-playground.txt"
const publicTools = mapleToolCatalog.filter((entry) => entry.audience === "public")

let rt: EvalRuntime | undefined
beforeAll(() => {
	if (env.PLAYGROUND_CMD !== "call") return
	installFakeWarehouse(infraFixtureRules(), undefined, "empty")
	rt = makeEvalRuntime()
})
afterAll(async () => {
	restoreWarehouse()
	await rt?.dispose()
})

const log = (entry: Record<string, unknown>) => {
	if (env.PLAYGROUND_LOG)
		appendFileSync(env.PLAYGROUND_LOG, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`)
}

it("playground", async () => {
	const tool = env.PLAYGROUND_TOOL ?? ""
	switch (env.PLAYGROUND_CMD) {
		case "catalog":
			return writeFileSync(out, publicTools.map((e) => `- ${e.name}: ${e.description}`).join("\n\n"))
		case "schema": {
			const entry = publicTools.find((candidate) => candidate.name === tool)
			return writeFileSync(
				out,
				entry === undefined
					? `Unknown tool "${tool}".`
					: JSON.stringify(inputSchemaOf(entry), null, 2),
			)
		}
		case "call": {
			if (rt === undefined) return writeFileSync(out, "The playground runtime did not start.")
			const started = Date.now()
			const params: unknown = JSON.parse(env.PLAYGROUND_ARGS ?? "{}")
			const result = await runToolDirect(rt, tool, params).then(
				(value) => ({ text: markdown(value), ok: value?.isError !== true }),
				(error: unknown) => ({ text: `Tool failed: ${String(error)}`, ok: false }),
			)
			writeFileSync(out, result.text)
			return log({
				tool,
				args: params,
				ok: result.ok,
				chars: result.text.length,
				ms: Date.now() - started,
			})
		}
		default:
			return writeFileSync(
				out,
				"usage: tool-playground.sh catalog | schema <tool> | call <tool> '<json>'",
			)
	}
})
