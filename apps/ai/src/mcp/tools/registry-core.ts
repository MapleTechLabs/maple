// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
import * as Policy from "@maple/domain/policy"
import { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import { scopeAllows } from "@maple/domain/http/v2"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { McpToolOutputs } from "@maple/domain/mcp-outputs"
import {
	Clock,
	Effect,
	Option,
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
	type McpToolAudience,
	type McpToolError,
	type McpToolHints,
	type McpToolPhrases,
	type McpToolRegistrar,
	type McpToolResult,
	refusalFor,
	refusesReadOnlyCredential,
} from "./types"
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
	readonly aliases: Readonly<Record<string, string>>
	readonly valueAliases: Readonly<Record<string, Readonly<Record<string, string>>>>
	readonly audience: McpToolAudience
	readonly scopeFamily?: string | ReadonlyArray<string>
	readonly phrases: McpToolPhrases
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

const publishCanonical = (node: unknown): unknown => {
	if (Arr.isArray(node)) return Arr.map(node, publishCanonical)
	if (!isJsonObject(node)) return node
	const anyOf = node.anyOf
	if (Arr.isArray(anyOf)) {
		const canonical = canonicalBranch(anyOf)
		if (isJsonObject(canonical)) {
			const { anyOf: _anyOf, ...siblings } = node
			return publishCanonical({ ...canonical, ...siblings })
		}
	}
	// `format: "uuid"` says what the UUID regex says, in a word instead of ~200 characters.
	const { pattern: _pattern, ...unpatterned } = node
	const published = node.format === "uuid" ? unpatterned : node
	return Rec.fromEntries(
		Arr.map(Rec.toEntries(published), ([key, value]) => [key, publishCanonical(value)]),
	)
}

export const toInputSchema = (schema: Schema.Top): Record<string, unknown> => {
	// `onExcessProperty: "error"` keeps `additionalProperties: false` on every
	// published tool. rc.116 made the emitted value follow this option and
	// defaults it to the decoder's behaviour, which would have loosened the
	// schema every public MCP tool advertises.
	const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
	const rawBase =
		Rec.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	const base = publishCanonical(collapseNullableUnions(inlineDefinitions(rawBase))) as typeof rawBase
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
	const definitions: MapleToolDefinition[] = []
	const define: McpToolRegistrar["define"] = (spec) => {
		if (!keep(spec.name)) return
		const outputSchema: Schema.Codec<unknown, unknown> = McpToolOutputs[spec.name]
		const encode = Schema.encodeUnknownEffect(outputSchema)
		definitions.push({
			name: spec.name,
			title: spec.title,
			description: spec.description,
			schema: spec.parameters,
			parseOptions: { onExcessProperty: spec.rejectUnknownKeys === true ? "error" : "ignore" },
			outputSchema,
			hints: spec.hints,
			aliases: spec.aliases ?? {},
			valueAliases: spec.valueAliases ?? {},
			audience: spec.audience ?? "public",
			...(spec.scopeFamily === undefined ? undefined : { scopeFamily: spec.scopeFamily }),
			phrases: spec.phrases,
			run: (params) =>
				Effect.gen(function* () {
					const output = yield* spec.handler(params)
					// A result that does not match its own schema is a bug, but the text is still right:
					// the model gets its answer and the UI falls back to the text.
					const structured = yield* encode(output).pipe(
						Effect.flatMap(Schema.decodeUnknownEffect(Schema.Json)),
						Effect.catch((error) =>
							Effect.logError("MCP tool output does not match its output schema").pipe(
								Effect.annotateLogs({
									"maple.mcp.tool": spec.name,
									"error.message": error.message,
								}),
								Effect.as(undefined),
							),
						),
					)
					return { doc: toolDocOf(spec, output), structured }
				}),
		})
	}
	Arr.forEach(registers, (register) => register({ define }))
	return definitions
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

const inputSchemas = new Map<string, Record<string, unknown>>()

/** The published input schema, computed on first use and kept: a hot path, and deterministic. */
export const inputSchemaOf = (entry: MapleToolCatalogEntry): Record<string, unknown> => {
	const cached = inputSchemas.get(entry.name)
	if (cached !== undefined) return cached
	const schema = toInputSchema(entry.schema)
	inputSchemas.set(entry.name, schema)
	return schema
}

const parameterNames = (entry: MapleToolCatalogEntry): ReadonlyArray<string> => {
	const properties = inputSchemaOf(entry).properties
	return typeof properties === "object" && properties !== null ? Rec.keys(properties) : []
}

const enumSpelling = (value: string): string => Str.replace(/[\s-]+/g, "_")(Str.toLowerCase(Str.trim(value)))

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
	const target = yield* lookup.find(call.tool)
	if (target === undefined) return { call, valid: false, hidden: false }
	if (!surfaceAdmits(target, surface)) return { call, valid: false, hidden: true }
	const normalized = normalizeFor(target, call.args)
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
	input: unknown,
	surface: McpToolSurface,
) {
	const definition = yield* lookup.find(name)
	if (!definition || !surfaceAdmits(definition, surface)) {
		if (definition) {
			yield* Effect.logWarning("MCP tool is not exposed on this surface").pipe(
				Effect.annotateLogs({ "maple.mcp.tool": name, "maple.mcp.surface": surface }),
			)
		}
		return yield* new McpToolNotFoundError({
			toolName: name,
			message: unknownToolMessage(name, lookup.namesFor(surface)),
		})
	}

	if (refusesReadOnlyCredential(definition.name, definition.hints.readOnly)) {
		const tenant = yield* CurrentMcpTenant
		const refusal = refusalFor(tenant, definition.name, definition.hints.readOnly)
		if (refusal !== undefined) {
			return yield* new McpAuthInvalidError({
				message:
					refusal === "analyst"
						? `\`${definition.name}\` changes data. ${Policy.analystMessage}`
						: `\`${definition.name}\` changes data, and this API key is read-only. Use a key with write access, or connect with OAuth.`,
				reason: "insufficient_scope",
			})
		}
	}

	if (definition.scopeFamily !== undefined) {
		const access = definition.hints.readOnly ? "read" : "write"
		const tenant = yield* CurrentMcpTenant
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
	return yield* finish(
		lookup,
		definition,
		{ ...run, doc: windowNotes.decorate(run.doc) },
		argumentWarnings(normalized, definition.name),
		surface,
	)
})
