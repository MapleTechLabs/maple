import { describe, expect, it } from "vitest"
import { Effect, Exit, Schema, Array as Arr, String as Str } from "effect"
import { mapleToolCatalog, mapleToolPhrase, readToolCall, toInputSchema } from "./registry"
import * as P from "../lib/params"

const jsonOf = (schema: unknown): string => JSON.stringify(schema)

describe("toInputSchema nullable-union collapse", () => {
	// The invariant `collapseNullableUnions` depends on. `Schema.optional(X)` types
	// as `X | undefined` and REJECTS an explicit null, but renders a JSON `null`
	// branch — so collapsing it makes the published schema match the decoder. A
	// `Schema.NullOr` parameter would render identically while genuinely accepting
	// null, and would be wrongly narrowed. If this ever fails, make the collapse
	// selective before trusting it again.
	it("no REQUIRED tool parameter carries a null branch", () => {
		// An optional parameter's null branch is the artifact being removed: absence
		// and null mean the same thing there, so collapsing is safe. A REQUIRED one
		// would be a real `Schema.NullOr` — null is a value it accepts — and
		// collapsing that would narrow the contract. None exist today; this fails if
		// one is ever added.
		const nullableRequired: string[] = []
		for (const definition of mapleToolCatalog) {
			const document = Schema.toJsonSchemaDocument(definition.schema)
			const schema = document.schema as {
				required?: ReadonlyArray<string>
				properties?: Record<string, { anyOf?: ReadonlyArray<{ type?: string }> }>
			}
			for (const name of schema.required ?? []) {
				const branches = schema.properties?.[name]?.anyOf ?? []
				if (Arr.some(branches, (branch) => branch.type === "null")) {
					nullableRequired.push(`${definition.name}.${name}`)
				}
			}
		}
		expect(nullableRequired).toEqual([])
	})

	it("publishes no null branch on any tool", () => {
		const withNull = Arr.map(
			Arr.filter(mapleToolCatalog, (d) =>
				Str.includes('"type":"null"')(jsonOf(toInputSchema(d.schema))),
			),
			(d) => d.name,
		)
		expect(withNull).toEqual([])
	})

	it("keeps the parameter description when it collapses the union", () => {
		const schema = toInputSchema(
			Schema.Struct({
				a: Schema.optional(Schema.String).annotate({ description: "the a param" }),
			}),
		)
		const properties = schema.properties as Record<string, Record<string, unknown>>
		expect(properties.a?.type).toBe("string")
		expect(properties.a?.description).toBe("the a param")
		expect(properties.a?.anyOf).toBeUndefined()
	})

	it("leaves a non-nullable union alone", () => {
		const schema = toInputSchema(Schema.Struct({ a: Schema.Union([Schema.String, Schema.Number]) }))
		const properties = schema.properties as Record<string, Record<string, unknown>>
		const types = Arr.map(properties.a?.anyOf as Array<{ type?: string }>, (member) => member.type)
		expect(types).toContain("string")
		expect(types).toContain("number")
		expect(types).not.toContain("null")
	})

	it("drops the null branch from a flattened optional union", () => {
		const schema = toInputSchema(
			Schema.Struct({ a: Schema.optional(Schema.Union([Schema.Literal("x"), Schema.Number])) }),
		)
		const properties = schema.properties as Record<string, Record<string, unknown>>
		const types = Arr.map(properties.a?.anyOf as Array<{ type?: string }>, (member) => member.type)
		expect(types).toContain("number")
		expect(types).not.toContain("null")
	})

	it("still marks optional parameters as not required", () => {
		const schema = toInputSchema(Schema.Struct({ a: Schema.optional(Schema.String), b: Schema.String }))
		expect(schema.required).toEqual(["b"])
	})
})

describe("P.optionalNumber", () => {
	const schema = Schema.Struct({ p: P.optionalNumber("a duration in ms") })
	const decode = (p: unknown) => Effect.runSyncExit(Schema.decodeUnknownEffect(schema)({ p }))
	const accepts = (p: unknown) => {
		const exit = decode(p)
		return Exit.isSuccess(exit) ? (exit.value as { p?: number }).p : "REJECTED"
	}

	// `Schema.Number` published `anyOf: [number, {string, enum: [Infinity, -Infinity, NaN]}]`
	// on all ~30 numeric parameters, because JSON cannot carry a non-finite number.
	// A model reading a "number or string" type reasonably sent "1500" — which the
	// decoder then rejected. `Schema.Finite` has no non-finite branch to encode.
	it("publishes a plain number, though numeric strings are still accepted", () => {
		expect(toInputSchema(schema).properties).toEqual({
			p: { type: "number", description: "a duration in ms" },
		})
	})

	it("publishes no non-finite enum branch on any tool in the catalog", () => {
		const withEnum = Arr.map(
			Arr.filter(mapleToolCatalog, (d) => Str.includes('"-Infinity"')(jsonOf(toInputSchema(d.schema)))),
			(d) => d.name,
		)
		expect(withEnum).toEqual([])
	})

	it("accepts numbers and numeric strings alike", () => {
		expect(accepts(1500)).toBe(1500)
		expect(accepts(0)).toBe(0)
		expect(accepts(-3)).toBe(-3)
		expect(accepts(1.5)).toBe(1.5)
		expect(accepts("1500")).toBe(1500)
		expect(accepts("1.5e3")).toBe(1500)
		expect(accepts(" 42 ")).toBe(42)
	})

	// `NumberFromString` is `Number(s)` and does not validate. Each of these would
	// otherwise decode to a value and ride into the warehouse query: "soon" as NaN,
	// "" and "   " as 0 — an empty result set instead of an error.
	it("rejects every string that is not a finite number", () => {
		for (const value of ["soon", "1500ms", "", "   ", "Infinity", "NaN"]) {
			expect(accepts(value)).toBe("REJECTED")
		}
	})

	it("rejects non-finite numbers and non-numeric types", () => {
		for (const value of [Number.POSITIVE_INFINITY, Number.NaN, null, true, {}]) {
			expect(accepts(value)).toBe("REJECTED")
		}
	})

	// These strings are read by a model mid-tool-call and are its only chance to
	// self-correct, so a rejection has to name the fix. The blank case originally
	// rendered as the useless `Expected <filter>`.
	it("explains how to correct a rejected value", () => {
		const message = (p: unknown) => {
			const exit = decode(p)
			return Exit.isFailure(exit) ? String(exit.cause) : "ACCEPTED"
		}
		expect(message("")).toContain("omit the parameter")
		expect(message("   ")).toContain("omit the parameter")
		expect(message("soon")).toContain("Expected a finite number")
		expect(message("")).not.toContain("<filter>")
	})

	// Absence still means absence — the leniency is about encoding, not presence.
	it("leaves an omitted parameter omitted", () => {
		expect(Effect.runSync(Schema.decodeEffect(schema)({}))).toEqual({})
	})
})

describe("mapleToolPhrase", () => {
	it("picks each tool's phrase from its own list", () => {
		for (const { name, phrases } of mapleToolCatalog) expect(phrases).toContain(mapleToolPhrase(name))
	})

	it("has nothing to say for a tool outside the registry", () => {
		expect(mapleToolPhrase("submit_diagnosis")).toBeUndefined()
	})
})

describe("enum values as models spell them", () => {
	const feedback = (kind: string) =>
		readToolCall("send_maple_feedback", { kind, summary: "s", reason: "r" })

	it("reads case, spaces and hyphens as the published value", () => {
		expect(feedback("Feature Request")?.args.kind).toBe("feature_request")
		expect(feedback("feature-request")?.decodes).toBe(true)
	})

	it("reads a declared alias as its target", () => {
		expect(feedback("docs")?.args.kind).toBe("documentation")
		expect(feedback("bug_report")?.args.kind).toBe("bug")
		expect(feedback("enhancement")?.decodes).toBe(true)
	})

	it("maps every declared value alias to a value its parameter publishes", () => {
		const broken = Arr.flatMap(mapleToolCatalog, (tool) =>
			Arr.flatMap(Object.entries(tool.valueAliases), ([parameter, aliases]) => {
				const properties = toInputSchema(tool.schema).properties
				const property =
					typeof properties === "object" && properties !== null
						? Object.entries(properties).find(([name]) => name === parameter)?.[1]
						: undefined
				const published =
					typeof property === "object" &&
					property !== null &&
					"enum" in property &&
					Arr.isArray(property.enum)
						? property.enum
						: []
				return Arr.flatMap(Object.entries(aliases), ([alias, target]) =>
					published.includes(target) && !published.includes(alias)
						? []
						: [`${tool.name}.${parameter}: ${alias}`],
				)
			}),
		)
		expect(broken).toEqual([])
	})

	it("still rejects a value nothing maps to", () => {
		expect(feedback("telepathy")?.decodes).toBe(false)
	})
})

describe("toInputSchema tagged-variant merge", () => {
	const Published = Schema.Struct({
		anyOf: Schema.optionalKey(Schema.Array(Schema.Unknown)),
		required: Schema.optionalKey(Schema.Array(Schema.String)),
		properties: Schema.optionalKey(
			Schema.Record(
				Schema.String,
				Schema.Struct({
					enum: Schema.optionalKey(Schema.Array(Schema.String)),
					description: Schema.optionalKey(Schema.String),
				}),
			),
		),
	})
	const rangeOf = (schema: Record<string, unknown>) =>
		Schema.decodeUnknownSync(Schema.Struct({ properties: Schema.Struct({ range: Published }) }))(schema)
			.properties.range

	const shared = { id: Schema.String, name: Schema.String, comment: Schema.optionalKey(Schema.String) }

	it("publishes one object for variants that differ by a tag and their own optional keys", () => {
		const schema = toInputSchema(
			Schema.Struct({
				range: Schema.Union([
					Schema.Struct({
						...shared,
						type: Schema.Literal("relative"),
						value: Schema.optionalKey(Schema.String),
					}),
					Schema.Struct({
						...shared,
						type: Schema.Literal("absolute"),
						start: Schema.optionalKey(Schema.String),
					}),
				]),
			}),
		)
		const range = rangeOf(schema)
		expect(range.anyOf).toBeUndefined()
		expect(range.properties?.type?.enum).toEqual(["relative", "absolute"])
		expect(range.properties?.name?.description).toBeUndefined()
		expect(range.properties?.value?.description).toBe("Only for type=relative.")
		expect(range.properties?.start?.description).toBe("Only for type=absolute.")
		expect(range.required).toEqual(["id", "name", "type"])
	})

	it("keeps the union when a key is required under one tag only, which one object cannot say", () => {
		const schema = toInputSchema(
			Schema.Struct({
				range: Schema.Union([
					Schema.Struct({ ...shared, type: Schema.Literal("weekly"), weekday: Schema.String }),
					Schema.Struct({ ...shared, type: Schema.Literal("daily") }),
				]),
			}),
		)
		expect(rangeOf(schema).anyOf).toHaveLength(2)
	})

	it("keeps the union when its branches are labelled", () => {
		const schema = toInputSchema(
			Schema.Struct({
				range: Schema.Union([
					Schema.Struct({ ...shared, type: Schema.Literal("drop") }).annotate({ title: "Drop" }),
					Schema.Struct({ ...shared, type: Schema.Literal("redact") }).annotate({
						title: "Redact",
					}),
				]),
			}),
		)
		expect(rangeOf(schema).anyOf).toHaveLength(2)
	})

	it("keeps the union where merging would not make the schema shorter", () => {
		const O = Schema.optionalKey(Schema.String)
		const schema = toInputSchema(
			Schema.Struct({
				range: Schema.Union([
					// Nothing shared but the tag: a note on every key outweighs the second object.
					Schema.Struct({ type: Schema.Literal("a"), p: O, q: O, r: O, s: O }),
					Schema.Struct({ type: Schema.Literal("b"), t: O, u: O, v: O, w: O }),
				]),
			}),
		)
		expect(rangeOf(schema).anyOf).toHaveLength(2)
	})

	it("keeps the union when the variants disagree on a shared key", () => {
		const schema = toInputSchema(
			Schema.Struct({
				range: Schema.Union([
					Schema.Struct({ type: Schema.Literal("relative"), value: Schema.String }),
					Schema.Struct({ type: Schema.Literal("absolute"), value: Schema.Number }),
				]),
			}),
		)
		expect(rangeOf(schema).anyOf).toHaveLength(2)
	})
})

describe("propose_fix arguments", () => {
	it("reads `summary` as the patch summary", () => {
		const call = readToolCall("propose_fix", {
			issue_id: "0190a8f2-7c3e-7d4a-9b1c-2f6e5d4c3b2a",
			summary: "Guard the nil session before reading its user",
		})
		expect(call?.unknown).toEqual([])
		expect(call?.args.patch_summary).toBe("Guard the nil session before reading its user")
	})
})
