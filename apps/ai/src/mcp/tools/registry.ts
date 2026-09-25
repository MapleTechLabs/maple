// BOUNDARY: This module owns unparsed external values and narrows them before domain use.
import { McpToolNotFoundError } from "@maple/domain/mcp-tool-contract"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { Effect, Schema } from "effect"
import { registerAddDashboardWidgetTool } from "./add-dashboard-widget"
import { registerDescribeWarehouseTablesTool } from "./describe-warehouse-tables"
import { registerComparePeriodsTool } from "./compare-periods"
import { registerCreateAlertRuleTool } from "./create-alert-rule"
import { registerUpdateAlertRuleTool } from "./update-alert-rule"
import { registerDeleteAlertRuleTool } from "./delete-alert-rule"
import { registerCreateDashboardTool } from "./create-dashboard"
import { registerDescribeDashboardSchemaTool } from "./describe-dashboard-schema"
import { registerDiagnoseServiceTool } from "./diagnose-service"
import { registerErrorDetailTool } from "./error-detail"
import { registerExploreAttributesTool } from "./explore-attributes"
import { registerFindErrorsTool } from "./find-errors"
import { registerFindSlowTracesTool } from "./find-slow-traces"
import { registerGetAlertRuleTool } from "./get-alert-rule"
import { registerGetDashboardTool } from "./get-dashboard"
import { registerGetIncidentTimelineTool } from "./get-incident-timeline"
import { registerAuditSetupTool } from "./audit-setup"
import { registerGetInstrumentationRecommendationsTool } from "./get-instrumentation-recommendations"
import { registerGetServiceTopOperationsTool } from "./get-service-top-operations"
import { registerInspectChartDataTool } from "./inspect-chart-data"
import { registerInspectTraceTool } from "./inspect-trace"
import { registerInspectSpanTool } from "./inspect-span"
import { registerListAlertChecksTool } from "./list-alert-checks"
import { registerListAlertIncidentsTool } from "./list-alert-incidents"
import { registerListAlertRulesTool } from "./list-alert-rules"
import { registerListAlertDestinationsTool } from "./list-alert-destinations"
import { registerClaimErrorIssueTool } from "./claim-error-issue"
import { registerCommentOnErrorIssueTool } from "./comment-on-error-issue"
import { registerListErrorIncidentsTool } from "./list-error-incidents"
import { registerListErrorIssueEventsTool } from "./list-error-issue-events"
import { registerListErrorIssuesTool } from "./list-error-issues"
import { registerLinkPullRequestTool } from "./link-pull-request"
import { registerProposeFixTool } from "./propose-fix"
import { registerRegisterAgentTool } from "./register-agent"
import { registerReleaseErrorIssueTool } from "./release-error-issue"
import { registerSetIssueSeverityTool } from "./set-issue-severity"
import { registerTransitionErrorIssueTool } from "./transition-error-issue"
import { registerUpdateErrorNotificationPolicyTool } from "./update-error-notification-policy"
import { registerListDashboardsTool } from "./list-dashboards"
import { registerListMetricsTool } from "./list-metrics"
import { registerListServicesTool } from "./list-services"
import { registerQueryDataTool } from "./query-data"
import { registerRunSqlTool } from "./run-sql"
import { registerRemoveDashboardWidgetTool } from "./remove-dashboard-widget"
import { registerReplaceDashboardWidgetsTool } from "./replace-dashboard-widgets"
import { registerReorderDashboardWidgetsTool } from "./reorder-dashboard-widgets"
import { registerMineLogPatternsTool } from "./mine-log-patterns"
import { registerSearchLogsTool } from "./search-logs"
import { registerSearchTracesTool } from "./search-traces"
import { registerSearchSessionsTool } from "./search-sessions"
import { registerQueryFunnelTool } from "./query-funnel"
import { registerListProductEventsTool } from "./list-product-events"
import { registerGetSessionTranscriptTool } from "./get-session-transcript"
import { registerGetSessionTracesTool } from "./get-session-traces"
import { registerListAgentSessionsTool } from "./list-agent-sessions"
import { registerGetAgentSessionTool } from "./get-agent-session"
import { registerGetAgentToolsOverviewTool } from "./get-agent-tools-overview"
import { registerGetAgentToolErrorTool } from "./get-agent-tool-error"
import { registerServiceMapTool } from "./service-map"
import { registerSourceCodeTools } from "./source-code"
import { registerSandboxTools } from "./sandbox"
import { registerPullRequestTools } from "./pull-request"
import {
	audienceAdmits,
	type McpToolAudience,
	type McpToolError,
	type McpToolHints,
	type McpToolPhrases,
	type McpToolRegistrar,
	type McpToolResult,
} from "./types"
import {
	argumentNotices,
	enumValues,
	formatDecodeFailure,
	normalizeArguments,
	type NormalizedArguments,
} from "../lib/decode-issues"
import { filterNextCalls, nextCallsOf, renderToolDoc, type NextCall, type ToolDoc } from "../lib/tool-doc"
import type { McpToolRequirements } from "./runtime-requirements"
import { registerUpdateDashboardTool } from "./update-dashboard"
import { registerUpdateDashboardWidgetTool } from "./update-dashboard-widget"

/** What a tool's handler produced: its typed output, rendered and encoded. */
interface ToolRun {
	readonly doc: ToolDoc
	readonly structured: Schema.Json | undefined
}

interface MapleToolDefinition extends MapleToolCatalogEntry {
	readonly run: (params: unknown) => Effect.Effect<ToolRun, McpToolError, McpToolRequirements>
}

export interface MapleToolCatalogEntry {
	readonly name: string
	readonly description: string
	readonly schema: Schema.Codec<unknown, unknown, never, unknown>
	readonly outputSchema: Schema.Codec<unknown, unknown, never, never>
	readonly hints: McpToolHints
	readonly aliases: Readonly<Record<string, string>>
	readonly audience: McpToolAudience
	readonly phrases: McpToolPhrases
}

class McpDecodeError extends Schema.TaggedError<McpDecodeError>()("@maple/mcp/decode-error", {
	errorMessage: Schema.String,
}) {
	override get message(): string {
		return this.errorMessage
	}
}

/**
 * The output schema's JSON Schema. MCP requires an object root, as for inputs. Unlike inputs, a
 * `null` branch here is real (`Schema.NullOr` fields), so nullable unions are kept.
 */
export const toOutputSchema = (schema: Schema.Top): Record<string, unknown> => {
	const document = Schema.toJsonSchemaDocument(schema)
	const base: Record<string, unknown> =
		Object.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	if (base.type !== "object" && !("$ref" in base)) {
		throw new Error(
			`MCP tool output schemas must have an object root; got ${JSON.stringify(base).slice(0, 200)}. Wrap the output in a Schema.Struct.`,
		)
	}
	return base
}

/**
 * Effect emits a rootless schema for an empty `Struct({})` — `{ not: { type:
 * "null" } }` since rc.116, `{ anyOf: [{ type: "object" }, { type: "array" }] }`
 * before it. Both are matched structurally, so the normalization below cannot
 * swallow any other rootless schema.
 */
const isEmptyStructSchema = (base: Record<string, unknown>): boolean => {
	if ("type" in base || "properties" in base) return false
	const not = base.not
	if (typeof not === "object" && not !== null) {
		const keys = Object.keys(base).filter((key) => key !== "$defs")
		if (keys.length === 1 && (not as { type?: unknown }).type === "null") {
			return Object.keys(not).length === 1
		}
	}
	const anyOf = base.anyOf
	if (!Array.isArray(anyOf) || anyOf.length === 0) return false
	return anyOf.every((member) => {
		if (typeof member !== "object" || member === null) return false
		const type = (member as { type?: unknown }).type
		return Object.keys(member).length === 1 && (type === "object" || type === "array")
	})
}

/**
 * Rewrite `anyOf: [T, {type: "null"}]` to plain `T`, keeping the sibling keys
 * (`description`, and anything else attached to the property).
 *
 * `Schema.optional(X)` — which CLAUDE.md mandates for MCP tool params — has type
 * `X | undefined`, but `toJsonSchemaDocument` renders that absence as a JSON
 * `null` branch. The published schema therefore told every MCP client that
 * `{"service": null}` was valid on every optional parameter of all 57 tools,
 * while the decoder rejects it with `Expected string | undefined`. An agent that
 * read the schema literally got "Invalid parameters" for doing what it was told.
 *
 * So this is a correctness fix first; it also happens to remove ~2.3k tokens
 * (17% of the published schema bytes) of union wrapper.
 *
 * Safe only while no MCP parameter is GENUINELY nullable — `Schema.NullOr` would
 * render identically and be wrongly narrowed here. `registry.test.ts` pins that
 * invariant by decoding `null` into every parameter of every tool.
 */
const collapseNullableUnions = (node: unknown): unknown => {
	if (Array.isArray(node)) return node.map(collapseNullableUnions)
	if (node === null || typeof node !== "object") return node
	const obj = node as Record<string, unknown>
	const anyOf = obj.anyOf
	if (Array.isArray(anyOf) && anyOf.length === 2) {
		const nullIndex = anyOf.findIndex(
			(member) => (member as Record<string, unknown> | null)?.type === "null",
		)
		if (nullIndex !== -1) {
			const { anyOf: _replaced, ...siblings } = obj
			const kept = anyOf[1 - nullIndex] as Record<string, unknown>
			// Siblings last: a `description` on the property outranks one on the branch.
			return collapseNullableUnions({ ...kept, ...siblings })
		}
	}
	return Object.fromEntries(Object.entries(obj).map(([key, value]) => [key, collapseNullableUnions(value)]))
}

const isJsonObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value)

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
		if (Array.isArray(node)) return node.map((item) => visit(item, trail))
		if (!isJsonObject(node)) return node
		const ref = node.$ref
		if (typeof ref === "string" && ref.startsWith(DEFS_PREFIX)) {
			const name = ref.slice(DEFS_PREFIX.length).replaceAll("~1", "/").replaceAll("~0", "~")
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
		return Object.fromEntries(
			Object.entries(node).flatMap(([key, value]) =>
				key === "$defs" ? [] : [[key, visit(value, trail)]],
			),
		)
	}
	const visited = visit(root, new Set())
	const inlined = isJsonObject(visited) ? visited : root
	return kept.size === 0
		? inlined
		: { ...inlined, $defs: Object.fromEntries([...kept].map((name) => [name, defs[name]])) }
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
	return branches.some(isString) && isJsonObject(other) && CANONICAL_TYPES.has(other.type)
		? other
		: undefined
}

const publishCanonical = (node: unknown): unknown => {
	if (Array.isArray(node)) return node.map(publishCanonical)
	if (!isJsonObject(node)) return node
	const anyOf = node.anyOf
	if (Array.isArray(anyOf)) {
		const canonical = canonicalBranch(anyOf)
		if (isJsonObject(canonical)) {
			const { anyOf: _anyOf, ...siblings } = node
			return publishCanonical({ ...canonical, ...siblings })
		}
	}
	// `format: "uuid"` says what the UUID regex says, in a word instead of ~200 characters.
	const { pattern: _pattern, ...unpatterned } = node
	const published = node.format === "uuid" ? unpatterned : node
	return Object.fromEntries(Object.entries(published).map(([key, value]) => [key, publishCanonical(value)]))
}

export const toInputSchema = (schema: Schema.Top): Record<string, unknown> => {
	// `onExcessProperty: "error"` keeps `additionalProperties: false` on every
	// published tool. rc.116 made the emitted value follow this option and
	// defaults it to the decoder's behaviour, which would have loosened the
	// schema all 57 public MCP tools advertise.
	const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
	const rawBase =
		Object.keys(document.definitions).length > 0
			? { ...document.schema, $defs: document.definitions }
			: document.schema
	const base = publishCanonical(collapseNullableUnions(inlineDefinitions(rawBase))) as typeof rawBase
	// MCP requires the top-level inputSchema to be an object schema (`type: "object"`).
	// An empty `Struct({})` (a no-parameter tool) comes out untyped, which strict MCP
	// clients reject — the Vercel AI SDK's `tools/list` Zod validator fails on
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
	// every MCP client as if it took none. Fail at registration instead — this runs at
	// module init, so it surfaces in tests and at worker boot rather than in the wire.
	if (record.type !== "object" && !("$ref" in record)) {
		throw new Error(
			`MCP tool input schemas must have an object root; got ${JSON.stringify(record).slice(0, 200)}. Wrap the tool input in a Schema.Struct.`,
		)
	}
	return base
}

const collectMapleToolDefinitions = (): ReadonlyArray<MapleToolDefinition> => {
	const definitions: MapleToolDefinition[] = []
	const define: McpToolRegistrar["define"] = (spec) => {
		const encode = Schema.encodeUnknownEffect(spec.output)
		definitions.push({
			name: spec.name,
			description: spec.description,
			schema: spec.parameters,
			outputSchema: spec.output,
			hints: spec.hints,
			aliases: spec.aliases ?? {},
			audience: spec.audience ?? "public",
			phrases: spec.phrases,
			run: (params) =>
				Effect.gen(function* () {
					const output = yield* spec.handler(params as typeof spec.parameters.Type)
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
					return { doc: spec.render(output), structured }
				}),
		})
	}
	const registrar: McpToolRegistrar = { define }

	registerFindErrorsTool(registrar)
	registerInspectTraceTool(registrar)
	registerInspectSpanTool(registrar)
	registerSearchLogsTool(registrar)
	registerMineLogPatternsTool(registrar)
	registerSearchTracesTool(registrar)
	registerSearchSessionsTool(registrar)
	registerQueryFunnelTool(registrar)
	registerListProductEventsTool(registrar)
	registerGetSessionTranscriptTool(registrar)
	registerGetSessionTracesTool(registrar)
	registerListAgentSessionsTool(registrar)
	registerGetAgentSessionTool(registrar)
	registerGetAgentToolsOverviewTool(registrar)
	registerGetAgentToolErrorTool(registrar)
	registerDiagnoseServiceTool(registrar)
	registerFindSlowTracesTool(registrar)
	registerErrorDetailTool(registrar)
	registerListMetricsTool(registrar)
	registerQueryDataTool(registrar)
	registerRunSqlTool(registrar)
	registerServiceMapTool(registrar)
	registerListAlertRulesTool(registrar)
	registerListAlertDestinationsTool(registrar)
	registerGetAlertRuleTool(registrar)
	registerListAlertIncidentsTool(registrar)
	registerListAlertChecksTool(registrar)
	registerGetIncidentTimelineTool(registrar)
	registerCreateAlertRuleTool(registrar)
	registerUpdateAlertRuleTool(registrar)
	registerDeleteAlertRuleTool(registrar)
	registerDescribeDashboardSchemaTool(registrar)
	registerListDashboardsTool(registrar)
	registerGetDashboardTool(registrar)
	registerCreateDashboardTool(registrar)
	registerUpdateDashboardTool(registrar)
	registerAddDashboardWidgetTool(registrar)
	registerDescribeWarehouseTablesTool(registrar)
	registerUpdateDashboardWidgetTool(registrar)
	registerRemoveDashboardWidgetTool(registrar)
	registerReplaceDashboardWidgetsTool(registrar)
	registerReorderDashboardWidgetsTool(registrar)
	registerInspectChartDataTool(registrar)
	registerComparePeriodsTool(registrar)
	registerExploreAttributesTool(registrar)
	registerListServicesTool(registrar)
	registerGetServiceTopOperationsTool(registrar)
	registerGetInstrumentationRecommendationsTool(registrar)
	registerAuditSetupTool(registrar)
	registerSourceCodeTools(registrar)
	registerSandboxTools(registrar)
	registerPullRequestTools(registrar)
	registerListErrorIssuesTool(registrar)
	registerTransitionErrorIssueTool(registrar)
	registerSetIssueSeverityTool(registrar)
	registerClaimErrorIssueTool(registrar)
	registerReleaseErrorIssueTool(registrar)
	registerCommentOnErrorIssueTool(registrar)
	registerProposeFixTool(registrar)
	registerLinkPullRequestTool(registrar)
	registerListErrorIssueEventsTool(registrar)
	registerRegisterAgentTool(registrar)
	registerListErrorIncidentsTool(registrar)
	registerUpdateErrorNotificationPolicyTool(registrar)

	return definitions
}

const mapleToolDefinitions = collectMapleToolDefinitions()

/** Handler-free registry view for schemas, permissions, MCP discovery, and tests. */
export const mapleToolCatalog: ReadonlyArray<MapleToolCatalogEntry> = mapleToolDefinitions.map(
	({ run: _run, ...entry }) => entry,
)

const inputSchemas = new Map<string, Record<string, unknown>>()

/** The published input schema, computed on first use and kept: a hot path, and deterministic. */
export const inputSchemaOf = (entry: MapleToolCatalogEntry): Record<string, unknown> => {
	let schema = inputSchemas.get(entry.name)
	if (schema === undefined) {
		schema = toInputSchema(entry.schema)
		inputSchemas.set(entry.name, schema)
	}
	return schema
}

const parameterNames = (entry: MapleToolCatalogEntry): ReadonlyArray<string> => {
	const properties = inputSchemaOf(entry).properties
	return typeof properties === "object" && properties !== null ? Object.keys(properties) : []
}

/** How a call's arguments are read before decoding: aliases applied, enum case fixed, unknowns dropped. */
const normalizeFor = (entry: MapleToolCatalogEntry, input: unknown) =>
	normalizeArguments(input, parameterNames(entry), entry.aliases, enumValues(inputSchemaOf(entry)))

const phrasesByName = new Map(mapleToolDefinitions.map(({ name, phrases }) => [name, phrases]))

/**
 * One of a tool's {@link McpToolPhrases}, at random, or undefined for a name outside the
 * registry. Picked once, when the call is declared: the event log keeps it, so every re-render of
 * the same call shows the same words.
 */
export const mapleToolPhrase = (name: string): string | undefined => {
	const phrases = phrasesByName.get(name)
	return phrases?.[Math.floor(Math.random() * phrases.length)]
}

/** The catalog as one surface sees it. What a surface cannot see, it cannot call either. */
export const mapleToolCatalogFor = (surface: McpToolSurface): ReadonlyArray<MapleToolCatalogEntry> =>
	mapleToolCatalog.filter((definition) => audienceAdmits(definition.audience, surface))

const toDecodeErrorMessage = (
	definition: MapleToolDefinition,
	error: unknown,
	normalized: NormalizedArguments,
): string =>
	Schema.isSchemaError(error)
		? formatDecodeFailure(definition.name, error, inputSchemaOf(definition), normalized)
		: String(error)

/**
 * Whether a suggested call would decode on the surface it is shown on. A next call naming a
 * parameter that was renamed, or a tool the caller cannot see, is worse than none.
 */
const isValidNextCall = (call: NextCall, surface: McpToolSurface): boolean => {
	const target = mapleToolDefinitions.find((candidate) => candidate.name === call.tool)
	if (target === undefined || !audienceAdmits(target.audience, surface)) return false
	const normalized = normalizeFor(target, call.args)
	return (
		normalized.unknown.length === 0 &&
		Schema.decodeUnknownOption(target.schema)(normalized.args)._tag === "Some"
	)
}

const finish = Effect.fnUntraced(function* (
	definition: MapleToolDefinition,
	run: ToolRun,
	notices: ReadonlyArray<string>,
	surface: McpToolSurface,
) {
	const invalid = nextCallsOf(run.doc).filter((call) => !isValidNextCall(call, surface))
	if (invalid.length > 0) {
		yield* Effect.logWarning("MCP tool suggested a call that does not decode").pipe(
			Effect.annotateLogs({
				"maple.mcp.tool": definition.name,
				"maple.mcp.next_calls": invalid.map((call) => call.tool).join(","),
			}),
		)
	}
	const doc = invalid.length === 0 ? run.doc : filterNextCalls(run.doc, (call) => !invalid.includes(call))
	const text = renderToolDoc(
		notices.length === 0 ? doc : { ...doc, notices: [...notices, ...(doc.notices ?? [])] },
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
export const executeRegisteredMcpToolUnscoped = Effect.fn("McpToolRegistry.execute")(function* (
	name: string,
	input: unknown,
	surface: McpToolSurface,
) {
	const definition = mapleToolDefinitions.find((candidate) => candidate.name === name)
	if (!definition || !audienceAdmits(definition.audience, surface)) {
		if (definition) {
			yield* Effect.logWarning("MCP tool is not exposed on this surface").pipe(
				Effect.annotateLogs({ "maple.mcp.tool": name, "maple.mcp.surface": surface }),
			)
		}
		return yield* new McpToolNotFoundError({
			name,
			message: `Unknown MCP tool: ${name}`,
		})
	}

	const normalized = normalizeFor(definition, input ?? {})
	yield* Effect.annotateCurrentSpan({
		tool: definition.name,
		"maple.mcp.tool.arguments": Object.keys(typeof input === "object" && input !== null ? input : {})
			.sort()
			.join(","),
		...(normalized.unknown.length === 0
			? undefined
			: { "maple.mcp.tool.unknown_arguments": normalized.unknown.map(({ key }) => key).join(",") }),
		...(normalized.renamed.length === 0
			? undefined
			: { "maple.mcp.tool.aliased_arguments": normalized.renamed.map(([from]) => from).join(",") }),
	})
	const decoded = yield* Schema.decodeUnknownEffect(definition.schema)(normalized.args).pipe(
		Effect.mapError(
			(error) =>
				new McpDecodeError({
					errorMessage: toDecodeErrorMessage(definition, error, normalized),
				}),
		),
	)

	const run = yield* definition.run(decoded)
	yield* Effect.logInfo("Tool completed")
	return yield* finish(definition, run, argumentNotices(normalized, definition.name), surface)
})
