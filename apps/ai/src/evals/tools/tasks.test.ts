/**
 * The tool tasks, checked against the live tool schemas. Free and deterministic, so it runs in the
 * unit suite: a renamed parameter or a dropped enum value fails here, where it is obvious, instead
 * of silently scoring every correct model call as wrong in the paid eval.
 */
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import { inputSchemaOf, mapleToolCatalogFor } from "../../mcp/tools/registry"
import type { ArgExpectation, Scalar } from "../targets"
import { TOOL_TASKS } from "./tasks"

const catalog = new Map(Arr.map(mapleToolCatalogFor("chat"), (entry) => [entry.name, entry]))

const isProperties = Schema.is(
	Schema.Record(Schema.String, Schema.Struct({ enum: Schema.optionalKey(Schema.Array(Schema.Unknown)) })),
)

const propertiesOf = (tool: string): Readonly<Record<string, { readonly enum?: ReadonlyArray<unknown> }>> => {
	const entry = catalog.get(tool)
	const properties = entry === undefined ? undefined : inputSchemaOf(entry).properties
	return isProperties(properties) ? properties : {}
}

const valuesOf = (expectation: ArgExpectation): ReadonlyArray<Scalar> => {
	if (typeof expectation !== "object") return [expectation]
	if ("oneOf" in expectation) return expectation.oneOf
	if ("orDefault" in expectation) return [expectation.orDefault]
	return []
}

describe("tool eval tasks", () => {
	it("have unique ids", () => {
		const ids = Arr.map(TOOL_TASKS, (task) => task.id)
		expect(ids.length).toBe(new Set(ids).size)
	})

	it.each(Arr.map(TOOL_TASKS, (task) => [task.id, task] as const))(
		"%s names only live tools and parameters",
		(_id, task) => {
			Arr.forEach(task.expect, (check) => {
				if (check.kind === "never") {
					Arr.forEach(check.tools, (tool) =>
						expect(catalog.has(tool), `unknown tool ${tool}`).toBe(true),
					)
				}
				if (check.kind !== "calls") return
				Arr.forEach(check.anyOf, (expectation) => {
					expect(catalog.has(expectation.tool), `unknown tool ${expectation.tool}`).toBe(true)
					const properties = propertiesOf(expectation.tool)
					Arr.forEach(Rec.toEntries(expectation.args ?? {}), ([key, value]) => {
						// A retired alias still decodes, but targets name the parameter the model is shown.
						expect(Rec.keys(properties), `${expectation.tool} has no parameter ${key}`).toContain(
							key,
						)
						const allowed = properties[key]?.enum
						if (allowed === undefined) return
						Arr.forEach(valuesOf(value), (scalar) =>
							expect(
								Arr.map(allowed, (entry) => Str.toLowerCase(String(entry))),
								`${expectation.tool}.${key} has no value ${String(scalar)}`,
							).toContain(Str.toLowerCase(String(scalar))),
						)
					})
				})
			})
		},
	)
})
