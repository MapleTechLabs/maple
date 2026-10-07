/**
 * The tool tasks, checked against the live tool schemas. Free and deterministic, so it runs in the
 * unit suite: a renamed parameter or a dropped enum value fails here, where it is obvious, instead
 * of silently scoring every correct model call as wrong in the paid eval.
 */
import { describe, expect, it } from "vitest"
import { inputSchemaOf, mapleToolCatalogFor } from "../../mcp/tools/registry"
import type { ArgExpectation, Scalar } from "../targets"
import { TOOL_TASKS } from "./tasks"

const catalog = new Map(mapleToolCatalogFor("chat").map((entry) => [entry.name, entry]))

const propertiesOf = (tool: string): Readonly<Record<string, { readonly enum?: ReadonlyArray<unknown> }>> => {
	const entry = catalog.get(tool)
	const properties = entry === undefined ? undefined : inputSchemaOf(entry).properties
	return typeof properties === "object" && properties !== null ? properties : {}
}

const valuesOf = (expectation: ArgExpectation): ReadonlyArray<Scalar> => {
	if (typeof expectation !== "object") return [expectation]
	if ("oneOf" in expectation) return expectation.oneOf
	if ("orDefault" in expectation) return [expectation.orDefault]
	return []
}

describe("tool eval tasks", () => {
	it("have unique ids", () => {
		const ids = TOOL_TASKS.map((task) => task.id)
		expect(ids.length).toBe(new Set(ids).size)
	})

	it.each(TOOL_TASKS.map((task) => [task.id, task] as const))(
		"%s names only live tools and parameters",
		(_id, task) => {
			task.expect.forEach((check) => {
				if (check.kind === "never") {
					check.tools.forEach((tool) =>
						expect(catalog.has(tool), `unknown tool ${tool}`).toBe(true),
					)
				}
				if (check.kind !== "calls") return
				check.anyOf.forEach((expectation) => {
					expect(catalog.has(expectation.tool), `unknown tool ${expectation.tool}`).toBe(true)
					const properties = propertiesOf(expectation.tool)
					Object.entries(expectation.args ?? {}).forEach(([key, value]) => {
						// A retired alias still decodes, but targets name the parameter the model is shown.
						expect(
							Object.keys(properties),
							`${expectation.tool} has no parameter ${key}`,
						).toContain(key)
						const allowed = properties[key]?.enum
						if (allowed === undefined) return
						valuesOf(value).forEach((scalar) =>
							expect(
								allowed.map((entry) => String(entry).toLowerCase()),
								`${expectation.tool}.${key} has no value ${String(scalar)}`,
							).toContain(String(scalar).toLowerCase()),
						)
					})
				})
			})
		},
	)
})
