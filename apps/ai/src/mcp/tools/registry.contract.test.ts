/**
 * What every tool in the registry promises, checked across the whole catalog so a new tool cannot
 * opt out of the contract by being registered differently.
 */
import { describe, expect, it } from "vitest"
import { mapleToolCatalog, inputSchemaOf, toOutputSchema } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"
import { McpToolOutputs } from "@maple/domain/mcp-outputs"

/** Parameter names that were retired for one spelling per concept. They live on only as aliases. */
const RETIRED_PARAMETERS = new Set(["service_name", "service_names", "since", "until"])

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const properties = (
	schema: Readonly<Record<string, unknown>>,
): ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> =>
	isRecord(schema.properties)
		? Object.entries(schema.properties).flatMap(([name, value]) =>
				isRecord(value) ? [[name, value] as const] : [],
			)
		: []

describe("MCP tool catalog contract", () => {
	it("declares every tool with typed output and hints", () => {
		const legacy = mapleToolCatalog
			.filter((tool) => tool.outputSchema === undefined || tool.hints === undefined)
			.map((tool) => tool.name)
		expect(legacy).toEqual([])
	})

	it("declares each tool's output as the schema the domain catalog lists for it", () => {
		const catalog: Readonly<Record<string, unknown>> = McpToolOutputs
		const mismatched = mapleToolCatalog
			.filter((tool) => catalog[tool.name] !== tool.outputSchema)
			.map((tool) => tool.name)
		expect(mismatched).toEqual([])
		expect(Object.keys(catalog).sort()).toEqual(mapleToolCatalog.map((tool) => tool.name).sort())
	})

	it("publishes an object-rooted output schema for every tool", () => {
		for (const tool of mapleToolCatalog) {
			if (tool.outputSchema === undefined) continue
			const output = tool.outputSchema
			expect(() => toOutputSchema(output), tool.name).not.toThrow()
		}
	})

	it("marks exactly the approval-gated tools as mutating", () => {
		const mutating = mapleToolCatalog
			.filter((tool) => tool.hints !== undefined && !tool.hints.readOnly)
			.map((tool) => tool.name)
			.sort()
		expect(mutating).toEqual([...MUTATING_TOOL_NAMES].sort())
	})

	it("uses one spelling per concept and describes every parameter", () => {
		const offenders: Array<string> = []
		for (const tool of mapleToolCatalog) {
			for (const [name, property] of properties(inputSchemaOf(tool))) {
				if (RETIRED_PARAMETERS.has(name)) offenders.push(`${tool.name}.${name}: retired name`)
				if (typeof property.description !== "string" || property.description.trim() === "") {
					offenders.push(`${tool.name}.${name}: no description`)
				}
			}
		}
		expect(offenders).toEqual([])
	})

	it("points every alias at a parameter the tool has", () => {
		const offenders: Array<string> = []
		for (const tool of mapleToolCatalog) {
			const names = new Set(properties(inputSchemaOf(tool)).map(([name]) => name))
			for (const [from, to] of Object.entries(tool.aliases)) {
				if (!names.has(to)) offenders.push(`${tool.name}: ${from} -> ${to}`)
				if (names.has(from)) offenders.push(`${tool.name}: alias ${from} shadows a parameter`)
			}
		}
		expect(offenders).toEqual([])
	})
})
