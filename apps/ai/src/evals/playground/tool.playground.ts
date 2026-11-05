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
import { Option, Schema, Array as Arr } from "effect"
import { RoleName } from "@maple/domain/primitives"
import { installFakeWarehouse, restoreWarehouse } from "@/mcp/__evals__/fake-warehouse"
import {
	integrationFixtureRules,
	seedCommitWorld,
	seedIntegrationWorld,
} from "@/mcp/__evals__/integration-world"
import { makeEvalRuntime, markdown, runToolDirect, type EvalRuntime } from "@/mcp/__evals__/eval-runtime"
import { infraFixtureRules } from "@/mcp/__evals__/infra-world"
import { providerFixtureRules } from "@/mcp/__evals__/provider-world"
import { securityCatalogFetch, securityFixtureRules, seedSecurityWorld } from "@/mcp/__evals__/security-world"
import { inputSchemaOf, mapleToolCatalog } from "@/mcp/tools/registry"

const env = process.env
const out = env.PLAYGROUND_OUT ?? "/tmp/maple-tool-playground.txt"
const publicTools = Arr.filter(mapleToolCatalog, (entry) => entry.audience === "public")

let rt: EvalRuntime | undefined
beforeAll(async () => {
	if (env.PLAYGROUND_CMD !== "call") return
	// The Security Center's release and advisory catalogs read endoflife.date and OSV.
	globalThis.fetch = securityCatalogFetch
	installFakeWarehouse(
		[
			...securityFixtureRules(),
			...integrationFixtureRules(),
			...providerFixtureRules(),
			...infraFixtureRules(),
		],
		undefined,
		"empty",
	)
	const base = makeEvalRuntime()
	// The playground plays an org admin, so the admin-only integration tools can be exercised.
	rt = { ...base, tenant: { ...base.tenant, roles: [Schema.decodeSync(RoleName)("org:admin")] } }
	await seedIntegrationWorld(rt)
	await seedCommitWorld(rt)
	await seedSecurityWorld(rt)
})
afterAll(async () => {
	restoreWarehouse()
	await rt?.dispose()
})

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown))
const encodePrettyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const decodeJson = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown))

const log = (entry: Record<string, unknown>) => {
	if (env.PLAYGROUND_LOG)
		appendFileSync(env.PLAYGROUND_LOG, `${encodeJson({ at: new Date().toISOString(), ...entry })}\n`)
}

it("playground", async () => {
	const tool = env.PLAYGROUND_TOOL ?? ""
	switch (env.PLAYGROUND_CMD) {
		case "catalog":
			return writeFileSync(
				out,
				Arr.join(
					Arr.map(publicTools, (e) => `- ${e.name}: ${e.description}`),
					"\n\n",
				),
			)
		case "schema": {
			return writeFileSync(
				out,
				Option.match(
					Arr.findFirst(publicTools, (candidate) => candidate.name === tool),
					{
						onNone: () => `Unknown tool "${tool}".`,
						onSome: (entry) => encodePrettyJson(inputSchemaOf(entry)),
					},
				),
			)
		}
		case "call": {
			if (rt === undefined) return writeFileSync(out, "The playground runtime did not start.")
			const started = Date.now()
			const params: unknown = decodeJson(env.PLAYGROUND_ARGS ?? "{}")
			const result = await runToolDirect(rt, tool, params).then(
				(value: unknown) => ({
					text: markdown(value),
					ok: !(
						typeof value === "object" &&
						value !== null &&
						"isError" in value &&
						value.isError === true
					),
				}),
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
