import type { CodeModeToolSpec, JsonSchema } from "./types.ts"

const MAX_METHOD_DESC = 280
const MAX_PROP_DESC = 100
const MAX_OBJECT_DEPTH = 2

/** Neutralize a comment terminator so a description can't close a JSDoc/inline comment. */
export const escapeJsDoc = (s: string): string => s.replace(/\*\//g, "*\\/")

/** Collapse whitespace and clamp to `max` chars so 50+ tools don't blow context. */
export const clampDesc = (s: string | undefined, max: number): string => {
	if (!s) return ""
	const oneLine = s.replace(/\s+/g, " ").trim()
	if (oneLine.length <= max) return oneLine
	return `${oneLine.slice(0, Math.max(0, max - 3))}...`
}

const safeIdent = (name: string): string =>
	/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name)

const literalUnion = (values: ReadonlyArray<unknown>): string | null => {
	const lits = values.filter(
		(v) => typeof v === "string" || typeof v === "number" || typeof v === "boolean",
	)
	if (lits.length !== values.length || lits.length === 0 || lits.length > 12) return null
	return Array.from(new Set(lits.map((v) => JSON.stringify(v)))).join(" | ")
}

/**
 * Pragmatic JSON-Schema → TS type. Accurate at the top level (property names,
 * required-ness, primitives, small enums) and deliberately coarse deeper down
 * (nested objects past `MAX_OBJECT_DEPTH` collapse to `Record<string, unknown>`).
 */
export const tsTypeForSchema = (schema: JsonSchema | undefined, depth = 0): string => {
	if (!schema || typeof schema !== "object") return "unknown"

	if (Array.isArray(schema.enum)) {
		const union = literalUnion(schema.enum)
		if (union) return union
	}

	const variants = schema.anyOf ?? schema.oneOf
	if (variants && variants.length > 0) {
		const parts = Array.from(new Set(variants.map((v) => tsTypeForSchema(v, depth))))
		return parts.join(" | ")
	}

	const rawType = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type
	switch (rawType) {
		case "string":
			return "string"
		case "number":
		case "integer":
			return "number"
		case "boolean":
			return "boolean"
		case "null":
			return "null"
		case "array":
			return `${tsTypeForSchema(schema.items, depth + 1)}[]`
		case "object":
			return objectType(schema, depth)
		default:
			return schema.properties ? objectType(schema, depth) : "unknown"
	}
}

const objectType = (schema: JsonSchema, depth: number): string => {
	const props = schema.properties
	if (!props || Object.keys(props).length === 0) return "Record<string, unknown>"
	if (depth >= MAX_OBJECT_DEPTH) return "Record<string, unknown>"
	const required = new Set(schema.required ?? [])
	const fields = Object.entries(props).map(([key, value]) => {
		const optional = required.has(key) ? "" : "?"
		const desc = clampDesc(value?.description, MAX_PROP_DESC)
		const comment = desc ? `/** ${escapeJsDoc(desc)} */ ` : ""
		return `${comment}${safeIdent(key)}${optional}: ${tsTypeForSchema(value, depth + 1)}`
	})
	return `{ ${fields.join("; ")} }`
}

/** The single `input` parameter type for a tool's generated method. */
export const inputTypeForTool = (schema: JsonSchema | undefined): string => {
	if (!schema?.properties || Object.keys(schema.properties).length === 0) {
		return "Record<string, unknown>"
	}
	return objectType(schema, 0)
}

/**
 * Render the `declare const maple: { ... }` surface the model writes code
 * against - one JSDoc'd async method per tool, sorted for stable output. Every
 * method returns `Promise<string>` (the tool's text output) and throws on
 * failure, so the model can `try/catch` or let the harness report the error.
 */
export const buildApiDeclaration = (tools: ReadonlyArray<CodeModeToolSpec>): string => {
	const methods = [...tools]
		.sort((a, b) => a.name.localeCompare(b.name))
		.map((tool) => {
			const desc = clampDesc(tool.description, MAX_METHOD_DESC)
			const jsdoc = desc ? `\t/** ${escapeJsDoc(desc)} */\n` : ""
			return `${jsdoc}\t${tool.name}(input: ${inputTypeForTool(tool.parameters)}): Promise<string>;`
		})
		.join("\n")
	return `declare const maple: {\n${methods}\n};`
}
