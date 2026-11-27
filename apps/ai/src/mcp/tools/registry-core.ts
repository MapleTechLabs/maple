// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
import * as Policy from "@maple/domain/policy"
import { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import { scopeAllows } from "@maple/domain/http/v2"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { McpToolFamilyActions, McpToolOutputs } from "@maple/domain/mcp-outputs"
import {
	Clock,
	Effect,
	Option,
	Predicate,
	Result,
	Schema,
	type SchemaAST,
	Array as Arr,
	Record as Rec,
	String as Str,
} from "effect"
import { CurrentMcpTenant } from "../tenant"
import {
	surfaceAdmits,
	McpAuthInvalidError,
	McpInvalidInputError,
	type McpToolAudience,
	type McpToolError,
	type McpToolFamilySpec,
	type McpToolHints,
	type McpToolPermission,
	type McpToolPhrases,
	type McpToolRegistrar,
	type McpToolResult,
	refusalFor,
} from "./types"
import { canonicalToolCall, enumSpelling, retiredOutputKey } from "./tool-name-aliases"
import { unknownToolMessage } from "../lib/tool-suggestions"
import {
	argumentWarnings,
	enumValues,
	formatDecodeFailure,
	normalizeArguments,
	type NormalizedArguments,
} from "../lib/decode-issues"
import { filterNextCalls, nextCallsOf, type NextCall, type ToolDoc } from "../lib/tool-doc"
import { stringifyJson } from "../lib/json"
import { renderToolDocWithinBudget } from "./tool-output"
import { CurrentWindowNotes, WindowNotes } from "../lib/window-notes"
import type { McpToolRequirements } from "./runtime-services"

/** What a tool's handler produced: its typed output, rendered and encoded. */
interface ToolRun {
	readonly doc: ToolDoc
	readonly structured: Schema.Json | undefined
}

export interface MapleToolDefinition extends MapleToolCatalogEntry {
	readonly run: (params: unknown) => Effect.Effect<ToolRun, McpToolError, McpToolRequirements>
	readonly actions?: ReadonlyArray<MapleToolDefinition & MapleToolActionEntry>
}

/** One action of a family: decoded, gated and run as a tool of its own under the family's name. */
export interface MapleToolActionEntry extends MapleToolCatalogEntry {
	readonly action: string
	readonly permission: Policy.Permission
}

export interface MapleToolCatalogEntry {
	readonly name: string
	readonly title: string
	readonly description: string
	readonly schema: Schema.Codec<unknown, unknown, never, unknown>
	/** How arguments decode; `rejectUnknownKeys` tools refuse nested keys the schema lacks. */
	readonly parseOptions: SchemaAST.ParseOptions
	readonly outputSchema: Schema.Codec<unknown, unknown>
	readonly hints: McpToolHints
	readonly permission: McpToolPermission
	readonly aliases: Readonly<Record<string, string>>
	readonly valueAliases: Readonly<Record<string, Readonly<Record<string, string>>>>
	readonly audience: McpToolAudience
	readonly scopeFamily?: string | ReadonlyArray<string>
	readonly phrases: McpToolPhrases
	/** A family's actions. Its own `schema` then only names the action: each action decodes its call. */
	readonly actions?: ReadonlyArray<MapleToolActionEntry>
	/** The input schema to publish, where it is not `schema`'s own: a family's, merged from its actions. */
	readonly publishedInputSchema?: () => Record<string, unknown>
}

class McpDecodeError extends Schema.TaggedError<McpDecodeError>()("@maple/mcp/errors/McpDecodeError", {
	message: Schema.String,
}) {}

/**
 * The output schema's JSON Schema. MCP requires an object root, as for inputs. Unlike inputs, a
 * `null` branch here is real (`Schema.NullOr` fields), so nullable unions are kept.
 */
export const toOutputSchema = (schema: Schema.Top): Record<string, unknown> => {
	const document = Schema.toJsonSchemaDocument(schema)
	const base: Record<string, unknown> =
		Rec.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	if (base.type !== "object" && !("$ref" in base)) {
		throw new Error(
			`MCP tool output schemas must have an object root; got ${Str.slice(0, 200)(String(stringifyJson(base)))}. Wrap the output in a Schema.Struct.`,
		)
	}
	return base
}

/**
 * Effect emits a rootless schema for an empty `Struct({})`: `{ not: { type:
 * "null" } }` since rc.116, `{ anyOf: [{ type: "object" }, { type: "array" }] }`
 * before it. Both are matched structurally, so the normalization below cannot
 * swallow any other rootless schema.
 */
const isEmptyStructSchema = (base: Record<string, unknown>): boolean => {
	if ("type" in base || "properties" in base) return false
	const not = base.not
	if (typeof not === "object" && not !== null) {
		const keys = Arr.filter(Rec.keys(base), (key) => key !== "$defs")
		if (keys.length === 1 && (not as { type?: unknown }).type === "null") {
			return Rec.keys(not).length === 1
		}
	}
	const anyOf = base.anyOf
	if (!Arr.isArray(anyOf) || anyOf.length === 0) return false
	return Arr.every(anyOf, (member) => {
		if (typeof member !== "object" || member === null) return false
		const type = (member as { type?: unknown }).type
		return Rec.keys(member).length === 1 && (type === "object" || type === "array")
	})
}

/**
 * Rewrite `anyOf: [T, {type: "null"}]` to plain `T`, keeping the sibling keys
 * (`description`, and anything else attached to the property).
 *
 * `Schema.optional(X)`, which CLAUDE.md mandates for MCP tool params, has type
 * `X | undefined`, but `toJsonSchemaDocument` renders that absence as a JSON
 * `null` branch. The published schema therefore told every MCP client that
 * `{"service": null}` was valid on every optional parameter of every tool,
 * while the decoder rejects it with `Expected string | undefined`. An agent that
 * read the schema literally got "Invalid parameters" for doing what it was told.
 *
 * So this is a correctness fix first; it also happens to remove ~2.3k tokens
 * (17% of the published schema bytes) of union wrapper.
 *
 * Safe only while no MCP parameter is GENUINELY nullable: `Schema.NullOr` would
 * render identically and be wrongly narrowed here. `registry.test.ts` pins that
 * invariant by decoding `null` into every parameter of every tool.
 * The one exception, `P.optionalNullableNumberOneOf`, is optional and names null in its description.
 */
const collapseNullableUnions = (node: unknown): unknown => {
	if (Arr.isArray(node)) return Arr.map(node, collapseNullableUnions)
	if (node === null || typeof node !== "object") return node
	const obj = node as Record<string, unknown>
	const anyOf = obj.anyOf
	if (Arr.isArray(anyOf)) {
		// Nested unions arrive flattened: `optional(Union([A, B]))` is `anyOf: [A, B, null]`.
		const kept = Arr.filter(anyOf, (member) => !isJsonObject(member) || member.type !== "null")
		if (kept.length > 0 && kept.length < anyOf.length) {
			const { anyOf: _replaced, ...siblings } = obj
			// Siblings last: a `description` on the property outranks one on the branch.
			return collapseNullableUnions(
				kept.length === 1 && isJsonObject(kept[0])
					? { ...kept[0], ...siblings }
					: { anyOf: kept, ...siblings },
			)
		}
	}
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(obj), ([key, value]) => [key, collapseNullableUnions(value)]),
	)
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const DEFS_PREFIX = "#/$defs/"

/**
 * Replace each `$ref` with the definition it names, keeping sibling keys. A branded parameter
 * (`issue_id` decoding to `ErrorIssueId`) otherwise publishes as a bare `$ref`, and its type and
 * description sit in `$defs` where a model reading the property never looks. Recursive
 * definitions stay referenced.
 */
const inlineDefinitions = (root: Record<string, unknown>): Record<string, unknown> => {
	const defs = isJsonObject(root.$defs) ? root.$defs : {}
	const kept = new Set<string>()
	const visit = (node: unknown, trail: ReadonlySet<string>): unknown => {
		if (Arr.isArray(node)) return Arr.map(node, (item) => visit(item, trail))
		if (!isJsonObject(node)) return node
		const ref = node.$ref
		if (typeof ref === "string" && Str.startsWith(DEFS_PREFIX)(ref)) {
			const name = Str.replaceAll(
				"~0",
				"~",
			)(Str.replaceAll("~1", "/")(Str.slice(DEFS_PREFIX.length)(ref)))
			const definition = defs[name]
			const expanded =
				isJsonObject(definition) && !trail.has(name)
					? visit(definition, new Set([...trail, name]))
					: undefined
			if (isJsonObject(expanded)) {
				const { $ref: _ref, $defs: _defs, ...siblings } = node
				return { ...expanded, ...siblings }
			}
			kept.add(name)
			return node
		}
		return Rec.fromEntries(
			Arr.flatMap(Rec.toEntries(node), ([key, value]) =>
				key === "$defs" ? [] : [[key, visit(value, trail)]],
			),
		)
	}
	const visited = visit(root, new Set())
	const inlined = isJsonObject(visited) ? visited : root
	return kept.size === 0
		? inlined
		: { ...inlined, $defs: Rec.fromEntries(Arr.map([...kept], (name) => [name, defs[name]])) }
}

const CANONICAL_TYPES: ReadonlySet<unknown> = new Set(["number", "boolean", "array"])

/**
 * The branch of a vocabulary union a model should send. `P.*` accepts looser encodings than
 * it asks for (`"15"` for a number, `"a,b"` for a list, JSON text or the object itself), and
 * publishing those invites them; the decoder still takes them either way.
 */
const canonicalBranch = (branches: ReadonlyArray<unknown>): unknown => {
	if (branches.length === 1) return branches[0]
	const jsonText = branches.find(
		(branch) => isJsonObject(branch) && branch.contentMediaType === "application/json",
	)
	if (jsonText !== undefined || branches.length !== 2) return jsonText
	const isString = (branch: unknown) => isJsonObject(branch) && branch.type === "string"
	const other = branches.find((branch) => !isString(branch))
	return Arr.some(branches, isString) && isJsonObject(other) && CANONICAL_TYPES.has(other.type)
		? other
		: undefined
}

const sameJson = (a: unknown, b: unknown): boolean => stringifyJson(a) === stringifyJson(b)

const jsonLength = (value: unknown): number => stringifyJson(value)?.length ?? 0

/** The one value a branch pins a key to (`dataSource: "logs"`), when it does. */
const tagValueOf = (schema: unknown): string | undefined => {
	if (!isJsonObject(schema) || !Arr.isArray(schema.enum) || schema.enum.length !== 1) return undefined
	const value = schema.enum[0]
	return typeof value === "string" ? value : undefined
}

/** The keywords a branch may carry and still merge: anything else, a label included, would be lost. */
const MERGEABLE_KEYWORDS: ReadonlySet<string> = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
])

/**
 * One object for a union whose branches are the same object under different tag values: shared
 * keys once, the tag as an enum, each optional key of some branches marked with their tag values.
 * Undefined where it would say something else: a key required under one tag only has no place in
 * one object. What it gives up is the union forbidding one tag's key under another, in prose only.
 */
export const mergeTaggedVariants = (
	branches: ReadonlyArray<unknown>,
): Record<string, unknown> | undefined => {
	const variants = Arr.filter(branches, isJsonObject)
	const first = variants[0]
	if (first === undefined || variants.length < 2 || variants.length !== branches.length) return undefined
	const propertiesOf = (variant: Record<string, unknown>) =>
		isJsonObject(variant.properties) ? variant.properties : undefined
	if (
		!Arr.every(
			variants,
			(variant) =>
				variant.type === "object" &&
				propertiesOf(variant) !== undefined &&
				Arr.every(Rec.keys(variant), (keyword) => MERGEABLE_KEYWORDS.has(keyword)) &&
				sameJson(variant.additionalProperties, first.additionalProperties),
		)
	) {
		return undefined
	}
	const tag = Arr.findFirst(Rec.keys(propertiesOf(first) ?? {}), (key) => {
		const values = Arr.map(variants, (variant) => tagValueOf(propertiesOf(variant)?.[key]))
		return Arr.every(values, (value) => value !== undefined) && new Set(values).size === values.length
	})
	if (Option.isNone(tag)) return undefined
	const tagOf = (variant: Record<string, unknown>) => tagValueOf(propertiesOf(variant)?.[tag.value]) ?? ""
	const tagsOf = (some: ReadonlyArray<Record<string, unknown>>) =>
		`${tag.value}=${Arr.join(Arr.map(some, tagOf), "|")}`
	const requires = (variant: Record<string, unknown>, key: string): boolean =>
		Arr.isArray(variant.required) && variant.required.includes(key)
	const keys = Arr.dedupe(Arr.flatMap(variants, (variant) => Rec.keys(propertiesOf(variant) ?? {})))
	const merged: Array<readonly [string, unknown]> = []
	for (const key of keys) {
		const holders = Arr.filter(variants, (variant) => key in (propertiesOf(variant) ?? {}))
		const schema = propertiesOf(holders[0] ?? first)?.[key]
		if (key === tag.value) {
			// The first branch's other constraints on the tag would bind every value: keep the union.
			const constraintsOf = (variant: Record<string, unknown>) => {
				const own = propertiesOf(variant)?.[key]
				const { enum: _enum, description: _text, ...constraints } = isJsonObject(own) ? own : {}
				return constraints
			}
			if (!Arr.every(variants, (variant) => sameJson(constraintsOf(variant), constraintsOf(first)))) {
				return undefined
			}
			// Each branch describes its own tag value: keep them all, named, rather than the first.
			const described = Arr.flatMap(variants, (variant) => {
				const own = propertiesOf(variant)?.[key]
				return isJsonObject(own) && typeof own.description === "string"
					? [`${tagOf(variant)}: ${own.description}`]
					: []
			})
			const { description: _description, ...tagSchema } = isJsonObject(schema) ? schema : {}
			merged.push([
				key,
				{
					...tagSchema,
					enum: Arr.map(variants, tagOf),
					...(described.length === 0 ? undefined : { description: Arr.join(described, " ") }),
				},
			])
			continue
		}
		if (!Arr.every(holders, (holder) => sameJson(propertiesOf(holder)?.[key], schema))) return undefined
		// One `required` list cannot say "under this tag only": such a union stays a union.
		const requiring = Arr.filter(holders, (holder) => requires(holder, key))
		if (requiring.length > 0 && requiring.length < variants.length) return undefined
		if (holders.length === variants.length) {
			merged.push([key, schema])
			continue
		}
		// A key that is not an object schema has nowhere to say whose it is: keep the union.
		if (!isJsonObject(schema)) return undefined
		const only = `Only for ${tagsOf(holders)}.`
		merged.push([
			key,
			{
				...schema,
				description: typeof schema.description === "string" ? `${schema.description} ${only}` : only,
			},
		])
	}
	const required = Arr.filter(keys, (key) => Arr.every(variants, (variant) => requires(variant, key)))
	const object = {
		type: "object",
		properties: Rec.fromEntries(merged),
		...(required.length === 0 ? undefined : { required }),
		...("additionalProperties" in first
			? { additionalProperties: first.additionalProperties }
			: undefined),
	}
	// Merging is for the repetition it removes: where it removes none, the union stays as written.
	return jsonLength(object) < jsonLength(branches) ? object : undefined
}

/**
 * `mergeVariants` is off for a tool that refuses keys a variant does not declare: one merged
 * object would publish, under every tag, a key such a tool accepts under one.
 */
const publishCanonical =
	(mergeVariants: boolean) =>
	(node: unknown): unknown => {
		const publish = publishCanonical(mergeVariants)
		if (Arr.isArray(node)) return Arr.map(node, publish)
		if (!isJsonObject(node)) return node
		const anyOf = node.anyOf
		if (Arr.isArray(anyOf)) {
			const canonical =
				canonicalBranch(anyOf) ?? (mergeVariants ? mergeTaggedVariants(anyOf) : undefined)
			if (isJsonObject(canonical)) {
				const { anyOf: _anyOf, ...siblings } = node
				return publish({ ...canonical, ...siblings })
			}
		}
		// `format: "uuid"` says what the UUID regex says, in a word instead of ~200 characters.
		const { pattern: _pattern, ...unpatterned } = node
		const published = node.format === "uuid" ? unpatterned : node
		return Rec.fromEntries(Arr.map(Rec.toEntries(published), ([key, value]) => [key, publish(value)]))
	}

export const toInputSchema = (
	schema: Schema.Top,
	/** How the tool decodes: `rejectUnknownKeys` tools publish their unions as written. */
	parseOptions?: SchemaAST.ParseOptions,
): Record<string, unknown> => {
	// `onExcessProperty: "error"` keeps `additionalProperties: false` on every
	// published tool. rc.116 made the emitted value follow this option and
	// defaults it to the decoder's behaviour, which would have loosened the
	// schema every public MCP tool advertises.
	const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
	const rawBase =
		Rec.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	const base = publishCanonical(parseOptions?.onExcessProperty !== "error")(
		collapseNullableUnions(inlineDefinitions(rawBase)),
	) as typeof rawBase
	// MCP requires the top-level inputSchema to be an object schema (`type: "object"`).
	// An empty `Struct({})` (a no-parameter tool) comes out untyped, which strict MCP
	// clients reject: the Vercel AI SDK's `tools/list` Zod validator fails on
	// `inputSchema.type` and drops EVERY tool from the connection. Normalize just that
	// case. `$ref` roots (hoisted schemas) already carry a valid object type.
	const record = base as Record<string, unknown>
	if (isEmptyStructSchema(record)) {
		return {
			type: "object",
			properties: {},
			additionalProperties: false,
			...("$defs" in record ? { $defs: record.$defs } : undefined),
		}
	}
	// A genuinely non-object root (a top-level `Schema.Union`/`Schema.Literals`/array)
	// has parameters that an empty object schema would erase, publishing the tool to
	// every MCP client as if it took none. Fail at registration instead: this runs at
	// module init, so it surfaces in tests and at worker boot rather than in the wire.
	if (record.type !== "object" && !("$ref" in record)) {
		throw new Error(
			`MCP tool input schemas must have an object root; got ${Str.slice(0, 200)(String(stringifyJson(record)))}. Wrap the tool input in a Schema.Struct.`,
		)
	}
	return base
}

/** A tool module's registration function, as `registry.ts` and the generated module map import it. */
export type McpToolRegister = (registrar: McpToolRegistrar) => void

/** A tool's rendered doc, marked when it shows telemetry text (see `untrustedOutput`). */
export const toolDocOf = <O>(
	spec: { readonly render: (output: O) => ToolDoc; readonly untrustedOutput?: true },
	output: O,
): ToolDoc => {
	const doc = spec.render(output)
	// An empty result's hints can name values read from the warehouse ("did you mean"), so they count too.
	const carries = doc.empty === undefined || (doc.empty.hints?.length ?? 0) > 0
	return spec.untrustedOutput === true && carries ? { ...doc, untrusted: true } : doc
}

/**
 * Runs registration functions and keeps the tools `keep` accepts. One module can register
 * several tools; the per-tool lookup defines only the one a call asked for.
 */
export const collectToolDefinitions = (
	registers: ReadonlyArray<McpToolRegister>,
	keep: (name: string) => boolean = () => true,
): ReadonlyArray<MapleToolDefinition> => {
	// In registration order. A family is built once every register has run, with all its actions.
	const pending: Array<() => MapleToolDefinition> = []
	const define: McpToolRegistrar["define"] = (spec) => {
		if (!keep(spec.name)) return
		const outputSchema: Schema.Codec<unknown, unknown> = McpToolOutputs[spec.name]
		const definition: MapleToolDefinition = {
			name: spec.name,
			title: spec.title,
			description: spec.description,
			schema: spec.parameters,
			parseOptions: { onExcessProperty: spec.rejectUnknownKeys === true ? "error" : "ignore" },
			outputSchema,
			hints: spec.hints,
			permission: spec.permission,
			aliases: spec.aliases ?? {},
			valueAliases: spec.valueAliases ?? {},
			audience: spec.audience ?? "public",
			...(spec.scopeFamily === undefined ? undefined : { scopeFamily: spec.scopeFamily }),
			phrases: spec.phrases,
			run: (params) =>
				Effect.gen(function* () {
					const output = yield* spec.handler(params)
					const structured = yield* encodeOutput(spec.name, outputSchema, output)
					return { doc: toolDocOf(spec, output), structured }
				}),
		}
		pending.push(() => definition)
	}
	const family: McpToolRegistrar["family"] = (spec) => {
		const actions: Array<MapleToolDefinition & MapleToolActionEntry> = []
		const builder: ReturnType<McpToolRegistrar["family"]> = {
			// Typed here as a string: the families share no action name, so the inferred key is `never`.
			action: (name: string, action) => {
				const resultSchema = FAMILY_RESULTS[spec.name]?.[name]
				if (resultSchema === undefined) {
					throw new Error(`${spec.name} has no action "${name}" in the domain catalog`)
				}
				const scopeFamily = action.scopeFamily ?? spec.scopeFamily
				actions.push({
					name: spec.name,
					action: name,
					title: spec.title,
					description: action.description,
					schema: action.parameters,
					parseOptions: {
						onExcessProperty: action.rejectUnknownKeys === true ? "error" : "ignore",
					},
					outputSchema: resultSchema,
					hints: action.hints,
					permission: action.permission,
					aliases: action.aliases ?? {},
					valueAliases: action.valueAliases ?? {},
					audience: spec.audience ?? "public",
					...(scopeFamily === undefined ? undefined : { scopeFamily }),
					phrases: spec.phrases,
					run: (params) =>
						Effect.gen(function* () {
							const output = yield* action.handler(params)
							const result = yield* encodeOutput(spec.name, resultSchema, output)
							return {
								doc: toolDocOf(action, output),
								structured: result === undefined ? undefined : { action: name, result },
							}
						}),
				})
				return builder
			},
		}
		if (keep(spec.name)) pending.push(() => toFamilyDefinition(spec, actions))
		return builder
	}
	Arr.forEach(registers, (register) => register({ define, family }))
	return Arr.map(pending, (build) => build())
}

/** Each family action's result schema, by family then action. */
const FAMILY_RESULTS: Readonly<Record<string, Readonly<Record<string, Schema.Codec<unknown, unknown>>>>> =
	McpToolFamilyActions

/**
 * A handler's output as its schema encodes it. A result that does not match its own schema is a
 * bug, but the text is still right: the model gets its answer and the UI falls back to the text.
 */
const encodeOutput = (tool: string, schema: Schema.Codec<unknown, unknown>, output: unknown) =>
	Schema.encodeUnknownEffect(schema)(output).pipe(
		Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
		Effect.catch((error) =>
			Effect.logError("MCP tool output does not match its output schema").pipe(
				Effect.annotateLogs({ "maple.mcp.tool": tool, "error.message": error.message }),
				Effect.as(undefined),
			),
		),
	)

/** What a family's own call decodes to: only the action. Each action decodes the rest itself. */
const FamilyCall = Schema.Struct({ action: Schema.String })

const listOf = (names: ReadonlyArray<string>): string => Arr.join(names, ", ")

/** A family's published properties: every action's, once, each saying which actions take it. */
const familyInputSchema = (
	family: string,
	actions: ReadonlyArray<MapleToolActionEntry>,
): Record<string, unknown> => {
	const schemas = Arr.map(actions, (entry) => {
		const properties = inputSchemaOf(entry).properties
		return { action: entry.action, properties: isJsonObject(properties) ? properties : {} }
	})
	const keys = Arr.dedupe(Arr.flatMap(schemas, (schema) => Rec.keys(schema.properties)))
	// The family reads `action` as which action to run, so an action's own would never arrive.
	if (keys.includes("action") || Arr.some(actions, (entry) => "action" in entry.aliases)) {
		throw new Error(`${family}: an action takes a parameter or alias named \`action\`. Rename it.`)
	}
	const merged = Arr.map(keys, (key) => {
		const holders = Arr.flatMap(schemas, (schema) => {
			const property = schema.properties[key]
			if (!isJsonObject(property)) return []
			const { description, ...typing } = property
			return [
				{
					action: schema.action,
					description: typeof description === "string" ? description : "",
					typing,
				},
			]
		})
		const first = holders[0]
		if (first === undefined || !Arr.every(holders, (holder) => sameJson(holder.typing, first.typing))) {
			throw new Error(`${family}: its actions give \`${key}\` different types. Name them apart.`)
		}
		const sameText = Arr.every(holders, (holder) => holder.description === first.description)
		const takenBy =
			holders.length === actions.length ? "" : `(${listOf(Arr.map(holders, (h) => h.action))}) `
		const description = sameText
			? `${takenBy}${first.description}`
			: Arr.join(
					Arr.map(holders, (holder) => `${holder.action}: ${holder.description}`),
					"; ",
				)
		return [key, { ...first.typing, description }] as const
	})
	return {
		type: "object",
		properties: Rec.fromEntries([
			[
				"action",
				{
					type: "string",
					enum: Arr.map(actions, (entry) => entry.action),
					description: "What to do.",
				},
			],
			...merged,
		]),
		required: ["action"],
		additionalProperties: false,
	}
}

/** The family's sentence, then each action with what it does and the parameters it cannot go without. */
const familyDescription = (summary: string, actions: ReadonlyArray<MapleToolActionEntry>): string =>
	Arr.join(
		[
			summary,
			...Arr.map(actions, (entry) => {
				const required = inputSchemaOf(entry).required
				const needs = Arr.isArray(required) ? Arr.filter(required, Predicate.isString) : []
				return `- action=${entry.action}: ${entry.description}${needs.length === 0 ? "" : ` Requires ${listOf(needs)}.`}`
			}),
		],
		"\n",
	)

const toFamilyDefinition = (
	spec: McpToolFamilySpec<keyof typeof McpToolFamilyActions>,
	actions: ReadonlyArray<MapleToolDefinition & MapleToolActionEntry>,
): MapleToolDefinition => {
	const names = Arr.map(actions, (entry) => entry.action)
	const listed = Rec.keys(FAMILY_RESULTS[spec.name] ?? {})
	if (names.length !== listed.length || !Arr.every(listed, (name) => names.includes(name))) {
		throw new Error(`${spec.name} registers ${listOf(names)}; the domain catalog lists ${listOf(listed)}`)
	}
	// One name is gated one way: a read beside the writes would be refused to every read-only key.
	if (Arr.some(actions, (entry) => entry.hints.readOnly)) {
		throw new Error(`${spec.name}: every action of a family changes data. A read is a tool of its own.`)
	}
	const permissions = Arr.dedupe(Arr.map(actions, (entry) => entry.permission))
	if (!Arr.isReadonlyArrayNonEmpty(permissions)) throw new Error(`${spec.name} has no actions`)
	const scopes = Arr.dedupe(Arr.flatMap(actions, (entry) => Arr.ensure(entry.scopeFamily ?? [])))
	let description: string | undefined
	let published: Record<string, unknown> | undefined
	return {
		name: spec.name,
		title: spec.title,
		// Both read every action's input schema, which a call to one action has no use for.
		get description() {
			description ??= familyDescription(spec.description, actions)
			return description
		},
		publishedInputSchema: () => {
			published ??= familyInputSchema(spec.name, actions)
			return published
		},
		schema: FamilyCall,
		parseOptions: { onExcessProperty: "ignore" },
		outputSchema: McpToolOutputs[spec.name],
		hints: {
			readOnly: false,
			destructive: Arr.some(actions, (entry) => entry.hints.destructive === true),
			idempotent: Arr.every(actions, (entry) => entry.hints.idempotent === true),
			openWorld: Arr.some(actions, (entry) => entry.hints.openWorld === true),
		},
		permission: permissions.length === 1 ? permissions[0] : permissions,
		aliases: {},
		valueAliases: {},
		audience: spec.audience ?? "public",
		// Every scope an action may ask for: what a key needs to run all of the family.
		...(scopes.length === 0 ? undefined : { scopeFamily: scopes }),
		phrases: spec.phrases,
		actions,
		run: () =>
			Effect.fail(
				new McpInvalidInputError({
					message: `\`${spec.name}\` runs one of its actions: ${listOf(names)}.`,
					parameter: "action",
				}),
			),
	}
}

/**
 * What a call is decoded and run as: the tool itself, or the action of a family its `action`
 * argument names, with the rest of the arguments. Fails with what to send instead.
 */
export const resolveToolCall = <
	D extends { readonly name: string; readonly actions?: ReadonlyArray<MapleToolActionEntry> },
>(
	definition: D,
	input: unknown,
): Result.Result<
	{ readonly target: D | NonNullable<D["actions"]>[number]; readonly input: unknown },
	string
> => {
	if (definition.actions === undefined) return Result.succeed({ target: definition, input })
	const names = listOf(Arr.map(definition.actions, (entry) => entry.action))
	const { action, ...rest } = isArgumentRecord(input) ? input : {}
	const asked = typeof action === "string" ? enumSpelling(action) : undefined
	const target = definition.actions.find((entry) => entry.action === asked)
	if (target !== undefined) return Result.succeed({ target, input: rest })
	return Result.fail(
		`Invalid parameters for \`${definition.name}\`:\n- ${
			asked === undefined
				? `Missing required \`action\`: one of ${names}.`
				: `\`action\` "${asked}" is not one of ${names}.`
		}`,
	)
}

/** One entry of `tool-modules.generated.ts`: a callable name and the module that defines it. */
export interface McpToolModule {
	/** What a call names: a registered tool, or a retired alias of one. */
	readonly name: string
	/** The registered tool that name means, the one `load` defines. */
	readonly tool: string
	readonly title: string
	readonly audience: McpToolAudience
	/** `hints.readOnly`, so a surface's names can be listed without loading every module. */
	readonly readOnly: boolean
	/** The tool's permission, so `tools/list` can hide what a caller may not call without loading it. */
	readonly permission: McpToolPermission
	readonly load: () => Promise<McpToolRegister>
}

/**
 * How the executor finds tools: the whole registry (chat, tests) or one module per call
 * (`tool-modules.generated.ts`). Both answer for the same names, aliases included.
 */
export interface McpToolLookup {
	/** The definition a name (or retired alias) means, or undefined outside the registry. */
	readonly find: (name: string) => Effect.Effect<MapleToolDefinition | undefined>
	/** The registered names a surface may see, in catalog order, for the unknown-tool message. */
	readonly namesFor: (surface: McpToolSurface) => ReadonlyArray<string>
}

const inputSchemas = new WeakMap<object, Record<string, unknown>>()

/**
 * The published input schema, computed on first use and kept: a hot path, and deterministic. Kept
 * per schema, not per name: a family's actions share its name and each has its own.
 */
export const inputSchemaOf = (entry: MapleToolCatalogEntry): Record<string, unknown> => {
	if (entry.publishedInputSchema !== undefined) return entry.publishedInputSchema()
	const cached = inputSchemas.get(entry.schema)
	if (cached !== undefined) return cached
	const schema = toInputSchema(entry.schema, entry.parseOptions)
	inputSchemas.set(entry.schema, schema)
	return schema
}

const parameterNames = (entry: MapleToolCatalogEntry): ReadonlyArray<string> => {
	const properties = inputSchemaOf(entry).properties
	return typeof properties === "object" && properties !== null ? Rec.keys(properties) : []
}

/**
 * An enum value as the model spelled it, read as the published one it means: `Feature Request`
 * and `feature-request` are `feature_request`, a declared value alias is its target. Anything
 * else is left for the decoder to reject with the allowed values.
 */
const canonicalEnumArguments = (entry: MapleToolCatalogEntry, input: unknown): unknown => {
	if (!isArgumentRecord(input)) return input
	const enums = enumValues(inputSchemaOf(entry))
	return Rec.map(input, (value, key) => {
		const allowed = enums.get(key)
		if (typeof value !== "string" || allowed === undefined || allowed.includes(value)) return value
		const spelled = enumSpelling(value)
		if (allowed.includes(spelled)) return spelled
		const target = entry.valueAliases[key]?.[spelled]
		return target !== undefined && allowed.includes(target) ? target : value
	})
}

/** How a call's arguments are read before decoding: aliases applied, enum spellings fixed, unknowns dropped. */
export const normalizeFor = (entry: MapleToolCatalogEntry, input: unknown, nowMs?: number) =>
	normalizeArguments(
		canonicalEnumArguments(entry, input),
		parameterNames(entry),
		entry.aliases,
		enumValues(inputSchemaOf(entry)),
		nowMs,
	)

export const isArgumentRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

const toDecodeErrorMessage = (
	definition: MapleToolDefinition,
	error: unknown,
	normalized: NormalizedArguments,
): string =>
	Schema.isSchemaError(error)
		? formatDecodeFailure(definition.name, error, inputSchemaOf(definition), normalized)
		: String(error)

/**
 * Whether a suggested call would decode on the surface it is shown on, and whether its tool is
 * one the surface cannot see (a shared tool pointing at it is expected). A next call naming a
 * parameter that was renamed, or a tool the caller cannot see, is worse than none.
 */
const checkNextCall = Effect.fnUntraced(function* (
	lookup: McpToolLookup,
	call: NextCall,
	surface: McpToolSurface,
) {
	const canonical = canonicalToolCall(call.tool, call.args)
	const found = yield* lookup.find(canonical.name)
	if (found === undefined) return { call, valid: false, hidden: false }
	if (!surfaceAdmits(found, surface)) return { call, valid: false, hidden: true }
	const resolved = resolveToolCall(found, canonical.input)
	if (Result.isFailure(resolved)) return { call, valid: false, hidden: false }
	const { target, input } = resolved.success
	const normalized = normalizeFor(target, input)
	const valid =
		normalized.unknown.length === 0 &&
		Schema.decodeUnknownOption(target.schema)(normalized.args, target.parseOptions)._tag === "Some"
	return { call, valid, hidden: false }
})

const finish = Effect.fnUntraced(function* (
	lookup: McpToolLookup,
	definition: MapleToolDefinition,
	run: ToolRun,
	warnings: ReadonlyArray<string>,
	surface: McpToolSurface,
) {
	const checked = yield* Effect.forEach(nextCallsOf(run.doc), (call) =>
		checkNextCall(lookup, call, surface).pipe(
			// The call already ran: a suggested tool whose module fails to load drops the hint, not the result.
			Effect.catchCause((cause) =>
				Effect.logWarning("MCP tool suggested a call whose tool failed to load", cause).pipe(
					Effect.annotateLogs({
						"maple.mcp.tool": definition.name,
						"maple.mcp.next_call": call.tool,
					}),
					Effect.as({ call, valid: false, hidden: true }),
				),
			),
		),
	)
	const invalid = Arr.filter(checked, (check) => !check.valid)
	const undecodable = Arr.filter(invalid, (check) => !check.hidden)
	if (undecodable.length > 0) {
		yield* Effect.logWarning("MCP tool suggested a call that does not decode").pipe(
			Effect.annotateLogs({
				"maple.mcp.tool": definition.name,
				"maple.mcp.next_calls": Arr.join(
					Arr.map(undecodable, (check) => check.call.tool),
					",",
				),
			}),
		)
	}
	const invalidCalls = Arr.map(invalid, (check) => check.call)
	const doc =
		invalidCalls.length === 0 ? run.doc : filterNextCalls(run.doc, (call) => !invalidCalls.includes(call))
	const text = renderToolDocWithinBudget(
		warnings.length === 0 ? doc : { ...doc, warnings: [...warnings, ...(doc.warnings ?? [])] },
	)
	const result: McpToolResult = {
		content: [{ type: "text", text }],
		...(run.structured === undefined ? undefined : { structuredContent: run.structured }),
	}
	return result
})

/** Fails with why the caller may not run this tool or action, naming what they lack. */
const refuseCaller = (
	tenant: Parameters<typeof refusalFor>[0],
	entry: Pick<MapleToolCatalogEntry, "name" | "permission" | "hints">,
) => {
	const refusal = refusalFor(tenant, {
		name: entry.name,
		permission: entry.permission,
		readOnly: entry.hints.readOnly,
	})
	if (refusal === undefined) return Effect.void
	if (refusal._tag === "permission") {
		// The same keys the HTTP gate writes, so a refused tool call is found by the same query.
		return Effect.annotateCurrentSpan({
			"maple.access.outcome": "denied",
			"maple.access.site": "tool",
			"maple.access.permission": refusal.permission,
		}).pipe(
			Effect.andThen(
				Effect.fail(
					new McpAuthInvalidError({
						message: Policy.denialFor(refusal.permission).message,
						reason: "insufficient_permission",
					}),
				),
			),
		)
	}
	return Effect.fail(
		new McpAuthInvalidError({
			message: `\`${entry.name}\` changes data, and this API key is read-only. Use a key with write access, or connect with OAuth.`,
			reason: "insufficient_scope",
		}),
	)
}

/**
 * The one raw registry entry point. Its full Effect environment is intentionally
 * preserved; only `McpToolExecutor` may close it with tenant and app services.
 *
 * The surface is part of the lookup: an internal tool called from a surface it
 * is not exposed on does not exist there, and gets the same answer as an unknown
 * name, so the public transport cannot enumerate the internal set by probing.
 */
export const executeRegisteredTool = Effect.fn("McpToolRegistry.execute")(function* (
	lookup: McpToolLookup,
	name: string,
	rawInput: unknown,
	surface: McpToolSurface,
) {
	// A retired name is the tool that replaced it, called with what the old name stood for.
	const call = canonicalToolCall(name, rawInput)
	const found = yield* lookup.find(call.name)
	if (!found || !surfaceAdmits(found, surface)) {
		if (found) {
			yield* Effect.logWarning("MCP tool is not exposed on this surface").pipe(
				Effect.annotateLogs({ "maple.mcp.tool": name, "maple.mcp.surface": surface }),
			)
		}
		return yield* new McpToolNotFoundError({
			toolName: name,
			message: unknownToolMessage(name, lookup.namesFor(surface)),
		})
	}
	// Refused before the arguments are read: a family is gated on holding one of its actions'
	// permissions here, and on the action's own below.
	const tenant = yield* CurrentMcpTenant
	yield* refuseCaller(tenant, found)

	const resolved = resolveToolCall(found, call.input)
	if (Result.isFailure(resolved)) {
		yield* Effect.annotateCurrentSpan({ "maple.mcp.tool": found.name })
		return yield* new McpDecodeError({ message: resolved.failure })
	}
	const { target: definition, input } = resolved.success
	if (definition !== found) yield* refuseCaller(tenant, definition)

	if (definition.scopeFamily !== undefined) {
		const access = definition.hints.readOnly ? "read" : "write"
		const missing = Arr.findFirst(
			Arr.ensure(definition.scopeFamily),
			(family) => !scopeAllows(tenant.scopes, { family, access }),
		)
		if (Option.isSome(missing)) {
			return yield* new McpAuthInvalidError({
				message: `\`${definition.name}\` needs the \`${missing.value}:${access}\` scope, which this API key lacks. Add it to the key, or use a full-access key.`,
				reason: "insufficient_scope",
			})
		}
	}

	const nowMs = yield* Clock.currentTimeMillis
	const normalized = normalizeFor(definition, input ?? {}, nowMs)
	yield* Effect.annotateCurrentSpan({
		"maple.mcp.tool": definition.name,
		...("action" in definition ? { "maple.mcp.tool.action": definition.action } : undefined),
		"maple.mcp.tool.arguments": Arr.join(
			Object.keys(typeof input === "object" && input !== null ? input : {}).sort(),
			",",
		),
		...(normalized.unknown.length === 0
			? undefined
			: {
					"maple.mcp.tool.unknown_arguments": Arr.join(
						Arr.map(normalized.unknown, ({ key }) => key),
						",",
					),
				}),
		...(normalized.renamed.length === 0
			? undefined
			: {
					"maple.mcp.tool.aliased_arguments": Arr.join(
						Arr.map(normalized.renamed, ([from]) => from),
						",",
					),
				}),
	})
	const decoded = yield* Schema.decodeUnknownEffect(definition.schema)(
		normalized.args,
		definition.parseOptions,
	).pipe(
		Effect.mapError(
			(error) =>
				new McpDecodeError({
					message: toDecodeErrorMessage(definition, error, normalized),
				}),
		),
	)

	const windowNotes = new WindowNotes()
	const run = yield* definition.run(decoded).pipe(Effect.provideService(CurrentWindowNotes, windowNotes))
	yield* Effect.logInfo("Tool completed")
	const result = yield* finish(
		lookup,
		definition,
		{ ...run, doc: windowNotes.decorate(run.doc) },
		argumentWarnings(normalized, definition.name),
		surface,
	)
	// Called by a retired name, it answers as that name did.
	const own = ownOutputOf(result.structuredContent, retiredOutputKey(name))
	return own === undefined ? result : { ...result, structuredContent: own }
})

const isJsonRecord = (value: Schema.Json | undefined): value is Readonly<Record<string, Schema.Json>> =>
	typeof value === "object" && value !== null && !Arr.isArray(value)

/** The part of a structured output under `key`, when there is one. */
const ownOutputOf = (structured: Schema.Json | undefined, key: string | undefined): Schema.Json | undefined =>
	key !== undefined && isJsonRecord(structured) ? structured[key] : undefined
