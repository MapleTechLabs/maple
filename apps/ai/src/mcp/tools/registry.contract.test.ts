/**
 * What every tool in the registry promises, checked across the whole catalog so a new tool cannot
 * opt out of the contract by being registered differently.
 */
import { describe, expect, it } from "vitest"
import { mapleToolCatalog, inputSchemaOf, toOutputSchema } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"
import { McpToolOutputs } from "@maple/domain/mcp-outputs"
import { Array as Arr, Record as Rec, String as Str } from "effect"

/** Parameter names that were retired for one spelling per concept. They live on only as aliases. */
const RETIRED_PARAMETERS = new Set(["service_name", "service_names", "since", "until"])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const properties = (
	schema: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> =>
	isRecord(schema.properties)
		? Arr.flatMap(Rec.toEntries(schema.properties), ([name, value]) =>
				isRecord(value) ? [[name, value] as const] : [],
			)
		: []

describe("MCP tool catalog contract", () => {
	it("declares every tool with typed output and hints", () => {
		const legacy = Arr.map(
			Arr.filter(
				mapleToolCatalog,
				(tool) => tool.outputSchema === undefined || tool.hints === undefined,
			),
			(tool) => tool.name,
		)
		expect(legacy).toEqual([])
	})

	// Directory listings (Claude's connector directory) reject tools without a title.
	it("gives every tool a distinct title", () => {
		const titles = Arr.map(mapleToolCatalog, (tool) => Str.trim(tool.title))
		expect(Arr.filter(titles, (title) => title === "")).toEqual([])
		expect(Arr.filter(titles, (title, index) => titles.indexOf(title) !== index)).toEqual([])
	})

	it("declares each tool's output as the schema the domain catalog lists for it", () => {
		const catalog: Readonly<Record<string, unknown>> = McpToolOutputs
		const mismatched = Arr.map(
			Arr.filter(mapleToolCatalog, (tool) => catalog[tool.name] !== tool.outputSchema),
			(tool) => tool.name,
		)
		expect(mismatched).toEqual([])
		expect(Rec.keys(catalog).sort()).toEqual(Arr.map(mapleToolCatalog, (tool) => tool.name).sort())
	})

	it("publishes an object-rooted output schema for every tool", () => {
		for (const tool of mapleToolCatalog) {
			if (tool.outputSchema === undefined) continue
			const document = toOutputSchema(tool.outputSchema)
			// A `$ref` root points into `$defs`; follow it to the type a client sees.
			const ref =
				typeof document.$ref === "string" ? Str.replace("#/$defs/", "")(document.$ref) : undefined
			const defs = isRecord(document.$defs) ? document.$defs : {}
			const root = ref === undefined ? document : defs[ref]
			expect(isRecord(root) ? root.type : undefined, tool.name).toBe("object")
		}
	})

	it("marks exactly the approval-gated tools as mutating", () => {
		const mutating = Arr.map(
			Arr.filter(mapleToolCatalog, (tool) => tool.hints !== undefined && !tool.hints.readOnly),
			(tool) => tool.name,
		).sort()
		expect(mutating).toEqual([...MUTATING_TOOL_NAMES].sort())
	})

	it("uses one spelling per concept and describes every parameter", () => {
		const offenders: Array<string> = []
		for (const tool of mapleToolCatalog) {
			for (const [name, property] of properties(inputSchemaOf(tool))) {
				if (RETIRED_PARAMETERS.has(name)) offenders.push(`${tool.name}.${name}: retired name`)
				if (typeof property.description !== "string" || Str.trim(property.description) === "") {
					offenders.push(`${tool.name}.${name}: no description`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	it("publishes the multi-issue transition with an array of ids", () => {
		const tool = mapleToolCatalog.find((candidate) => candidate.name === "transition_error_issues")
		expect(tool?.hints?.readOnly).toBe(false)
		const ids = properties(tool === undefined ? {} : inputSchemaOf(tool)).find(
			([name]) => name === "issue_ids",
		)
		expect(JSON.stringify(ids?.[1])).toContain('"array"')
	})

	it("publishes a value that clears a picked check interval, since the schema cannot say null", () => {
		for (const name of ["create_alert_rule", "update_alert_rule"]) {
			const tool = mapleToolCatalog.find((candidate) => candidate.name === name)
			const interval = properties(tool === undefined ? {} : inputSchemaOf(tool)).find(
				([parameter]) => parameter === "evaluation_interval_minutes",
			)
			expect(JSON.stringify(interval?.[1])).toContain('"auto"')
		}
	})

	it("points every alias at a parameter the tool has", () => {
		const offenders: Array<string> = []
		for (const tool of mapleToolCatalog) {
			const names = new Set(Arr.map(properties(inputSchemaOf(tool)), ([name]) => name))
			for (const [from, to] of Rec.toEntries(tool.aliases)) {
				if (!names.has(to)) offenders.push(`${tool.name}: ${from} -> ${to}`)
				if (names.has(from)) offenders.push(`${tool.name}: alias ${from} shadows a parameter`)
			}
		}
		expect(offenders).toEqual([])
	})
})
