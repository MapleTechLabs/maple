import type { Effect } from "effect"
import { Schema } from "effect"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import type {
	McpToolFamilyActions,
	McpToolFamilyName,
	McpToolName,
	McpToolOutputs,
} from "@maple/domain/mcp-outputs"
import type { McpToolRequirements } from "./runtime-services"
import type { ToolDoc } from "../lib/tool-doc"
import * as Policy from "@maple/domain/policy"

export class McpAuthMissingError extends Schema.TaggedError<McpAuthMissingError>()(
	"@maple/mcp/errors/McpAuthMissingError",
	{ message: Schema.String, header: Schema.optionalKey(Schema.String) },
) {}

export class McpAuthInvalidError extends Schema.TaggedError<McpAuthInvalidError>()(
	"@maple/mcp/errors/McpAuthInvalidError",
	{ message: Schema.String, reason: Schema.optionalKey(Schema.String) },
) {}

export class McpAuthUnavailableError extends Schema.TaggedError<McpAuthUnavailableError>()(
	"@maple/mcp/errors/McpAuthUnavailableError",
	{ message: Schema.String },
) {}

export class McpInvalidTenantError extends Schema.TaggedError<McpInvalidTenantError>()(
	"@maple/mcp/errors/McpInvalidTenantError",
	{ message: Schema.String, field: Schema.String },
) {}

export class McpQueryError extends Schema.TaggedError<McpQueryError>()("@maple/mcp/errors/McpQueryError", {
	message: Schema.String,
	pipeName: Schema.String,
	cause: Schema.optionalKey(Schema.Defect()),
}) {}

/**
 * The call decoded but asks for something the tool will not do: a bad combination, an id that
 * does not parse, a window wider than the tool scans. An expected 400; the model fixes the call.
 */
export class McpInvalidInputError extends Schema.TaggedError<McpInvalidInputError>()(
	"@maple/mcp/errors/McpInvalidInputError",
	{
		message: Schema.String,
		parameter: Schema.optionalKey(Schema.String),
		example: Schema.optionalKey(Schema.String),
	},
) {}

/**
 * Something the tool depends on is still warming up (a repository clone, say). The same call
 * will work later, so this is not a failure of the call and the model should come back to it.
 */
export class McpNotReadyError extends Schema.TaggedError<McpNotReadyError>()(
	"@maple/mcp/errors/McpNotReadyError",
	{
		message: Schema.String,
		retryAfterSeconds: Schema.Number,
	},
) {}

/**
 * A capability the tool needs is not set up for this org or deployment (no GitHub App, no
 * connected repository). Retrying cannot help; the model should use other evidence.
 */
export class McpUnavailableError extends Schema.TaggedError<McpUnavailableError>()(
	"@maple/mcp/errors/McpUnavailableError",
	{ message: Schema.String, capability: Schema.String },
) {}

/**
 * The query ran into a warehouse budget: execution time or memory. Narrowing the window or
 * adding filters is the fix, which is what the message says, rather than the vendor's text.
 */
export class McpQueryBudgetError extends Schema.TaggedError<McpQueryBudgetError>()(
	"@maple/mcp/errors/McpQueryBudgetError",
	{ message: Schema.String, pipeName: Schema.String, setting: Schema.String },
) {}

/**
 * What a tool handler may fail with. Credential and tenant failures (`McpAuthMissingError`,
 * `McpAuthUnavailableError`, `McpInvalidTenantError`) happen at the transport, before any tool runs.
 */
export type McpToolError =
	| McpAuthInvalidError
	| McpQueryError
	| McpInvalidInputError
	| McpNotReadyError
	| McpUnavailableError
	| McpQueryBudgetError

export interface McpToolResult {
	content: Array<{ type: "text"; text: string }>
	/**
	 * The tool's typed output, encoded by its output schema: the public transport's
	 * `structuredContent`, and the chat UI's payload. Never shown to a model.
	 */
	structuredContent?: Schema.Json
	isError?: boolean
	/** What kind of failure an `isError` result is, for telemetry. Not sent to any client. */
	failureCategory?: string
}

/** MCP tool annotations, declared by every tool. Clients use them to decide what needs a confirm. */
export interface McpToolHints {
	/** Reads only: nothing in the org changes. */
	readonly readOnly: boolean
	/** Can remove or overwrite something the caller cannot restore. Only meaningful when not read-only. */
	readonly destructive?: boolean
	/** Repeating the call with the same arguments changes nothing further. */
	readonly idempotent?: boolean
	/** Reaches a system outside Maple's own data, such as GitHub or a repository checkout. */
	readonly openWorld?: boolean
}

/**
 * Maple's own feedback channel. It writes, yet stays open to read-only keys as on v2, and a
 * failure of it never asks the caller to report that failure through it.
 */
export const FEEDBACK_TOOL = "send_maple_feedback"

/**
 * Whether a read-only credential is refused this tool, and so never shown it: every tool that
 * changes data, except {@link FEEDBACK_TOOL}.
 */
export const refusesReadOnlyCredential = (name: string, readOnly: boolean): boolean =>
	!readOnly && name !== FEEDBACK_TOOL

/** The tools that build dashboards: the only changes an analyst's role reaches. */
export const DASHBOARD_AUTHORING_TOOLS: ReadonlySet<string> = new Set([
	"create_dashboard",
	"update_dashboard",
	"delete_dashboard",
	"add_dashboard_widget",
	"update_dashboard_widget",
	"remove_dashboard_widget",
	"reorder_dashboard_widgets",
	"replace_dashboard_widgets",
])

/** The tools that read an org's connected data sources: absent for an org without that feature. */
export const DATA_SOURCE_TOOLS: ReadonlySet<string> = new Set(["list_data_sources", "query_data_source"])

/** Tools that change only the caller's own state, which an analyst's role reaches (v2's `personal`). */
export const PERSONAL_STATE_TOOLS: ReadonlySet<string> = new Set(["onboarding_status_update"])

/** Whether an analyst is refused this tool: one that changes data, not a dashboard or their own state. */
export const refusesAnalyst = (name: string, readOnly: boolean): boolean =>
	refusesReadOnlyCredential(name, readOnly) &&
	!DASHBOARD_AUTHORING_TOOLS.has(name) &&
	!PERSONAL_STATE_TOOLS.has(name)

/** Why this caller is refused the tool, and so never shown it: their key, their role, or nothing. */
export const refusalFor = (
	tenant: { readonly readOnly?: true; readonly roles: ReadonlyArray<string> },
	name: string,
	readOnly: boolean,
): "analyst" | "read_only_key" | undefined => {
	if (Policy.isAnalyst(tenant.roles) && refusesAnalyst(name, readOnly)) return "analyst"
	if (tenant.readOnly === true && refusesReadOnlyCredential(name, readOnly)) return "read_only_key"
	return undefined
}

/**
 * Who a tool is for: `public` everywhere (the MCP transport included), `agent` Maple's own agents
 * and the bot, `internal` the in-product agents only. Declared at registration, never inferred.
 */
export type McpToolAudience = "public" | "agent" | "internal"

/**
 * What a call is doing, in words a chat channel reads while it runs: `Running a query`, never
 * `run_sql`. Several where one tool is called repeatedly in a turn, so the status line does not
 * read as stuck; each one says only what the tool does, never why or what it found.
 */
export type McpToolPhrases = readonly [string, ...Array<string>]

/**
 * The surfaces an `agent` tool is offered on: every Maple agent, the bot included when it
 * answers a linked Maple user.
 *
 * The bot answers into a channel anyone in it can read, as the Maple user who asked. The sandbox
 * tools are fit for that: the checkout is the same source `read_source_file` already serves the
 * bot, and `sandbox_exec` runs unprivileged, read-only, with no network and an empty environment,
 * so its output is the repository and what can be computed from it.
 */
const AGENT_SURFACES: ReadonlySet<McpToolSurface> = new Set<McpToolSurface>(["chat", "workflow", "bot"])

/**
 * The surfaces an `internal` tool is offered on: Maple's own agents, answering someone who is
 * already inside the product. `bot` is absent: these act on the org's behalf in ways a channel
 * post was never meant to reach (the pull request reviewer's tools).
 */
const INTERNAL_SURFACES: ReadonlySet<McpToolSurface> = new Set<McpToolSurface>(["chat", "workflow"])

/** The bot answering someone Maple cannot name: a connector with no account linking. */
const ANONYMOUS_SURFACE: McpToolSurface = "bot_anonymous"

/**
 * Everything {@link ANONYMOUS_SURFACE} is offered: the org's telemetry and alerting state. A tool
 * is absent there until it is named here, so one that reads a connected system, source, SQL,
 * session records or agent transcripts never arrives by default.
 */
const ANONYMOUS_TOOLS: ReadonlySet<string> = new Set([
	"audit_setup",
	"compare_log_patterns",
	"compare_operations",
	"compare_periods",
	"db_query_volume",
	"diagnose_service",
	"error_detail",
	"explore_attributes",
	"find_errors",
	"find_slow_traces",
	"get_alert_rule",
	"get_error_notification_policy",
	"get_incident_timeline",
	"get_instrumentation_recommendations",
	"get_service_top_operations",
	"get_status_page",
	"ingest_freshness",
	"ingest_usage",
	"inspect_slo",
	"inspect_span",
	"inspect_trace",
	"list_alert_checks",
	"list_alert_incidents",
	"list_alert_rules",
	"list_alert_silences",
	"list_dashboards",
	"list_error_incidents",
	"list_error_issues",
	"list_escalation_chains",
	"list_maintenance_windows",
	"list_metrics",
	"list_oncall_schedules",
	"list_services",
	"list_slos",
	"list_uptime_monitors",
	"mine_log_patterns",
	"profile_hotspots",
	"query_data",
	"route_usage",
	"search_logs",
	"search_traces",
	"service_deployments",
	"service_map",
	"who_is_on_call",
] satisfies ReadonlyArray<McpToolName>)

/** Whether a surface may see and call a tool of this audience. */
const audienceAdmits = (audience: McpToolAudience, surface: McpToolSurface): boolean => {
	switch (audience) {
		case "public":
			return true
		case "agent":
			return AGENT_SURFACES.has(surface)
		case "internal":
			return INTERNAL_SURFACES.has(surface)
	}
}

/**
 * Whether a surface may see and call this tool. Where nobody is named it must also be listed in
 * {@link ANONYMOUS_TOOLS} and change nothing: a change is only ever applied as a Maple user.
 */
export const surfaceAdmits = (
	tool: {
		readonly name: string
		readonly audience: McpToolAudience
		readonly hints: Pick<McpToolHints, "readOnly">
	},
	surface: McpToolSurface,
): boolean =>
	audienceAdmits(tool.audience, surface) &&
	(surface !== ANONYMOUS_SURFACE || (ANONYMOUS_TOOLS.has(tool.name) && tool.hints.readOnly))

/**
 * A tool, declared as data: typed input, typed output, how the output reads to a model, and what
 * the call may do. The registry owns everything around it (decode, aliases, errors, encoding
 * the output, rendering the text, checking next calls), so no tool can do those differently.
 */
export interface McpToolSpec<
	P extends Schema.Codec<unknown, unknown, never, unknown>,
	N extends McpToolName,
	R extends McpToolRequirements,
> {
	/** Also the key of the tool's output schema in `McpToolOutputs`, published as `outputSchema`. */
	readonly name: N
	/** Human-readable name, shown by clients in place of `name`. Title Case, no trailing period. */
	readonly title: string
	readonly description: string
	readonly parameters: P
	readonly hints: McpToolHints
	/** Defaults to `public`. */
	readonly audience?: McpToolAudience
	/**
	 * The v2 scope families a scoped API key must also hold (read for read-only tools, else write), as
	 * the matching `/v2/<family>` routes require. For data outside the toolset's baseline families.
	 */
	readonly scopeFamily?: string | ReadonlyArray<string>
	readonly phrases: McpToolPhrases
	/** Retired parameter names mapped to their current name. Accepted, never published. */
	readonly aliases?: Readonly<Record<string, string>>
	/**
	 * Per enum parameter, other spellings of a published value (`feature` for `feature_request`).
	 * Accepted, never published. Case, spaces and hyphens are already forgiven for every enum.
	 */
	readonly valueAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
	/**
	 * Refuse keys a nested object parameter does not declare, instead of dropping them. For
	 * documents that replace state, where a dropped typo would reset a field to its default.
	 */
	readonly rejectUnknownKeys?: true
	/**
	 * The result shows text the monitored systems wrote (log bodies, error messages, span names,
	 * attribute values): every non-empty result then carries the untrusted-data notice.
	 */
	readonly untrustedOutput?: true
	readonly handler: (params: P["Type"]) => Effect.Effect<McpToolOutput<N>["Type"], McpToolError, R>
	/** The model-facing text, derived from the output alone so the two cannot disagree. */
	readonly render: (output: McpToolOutput<N>["Type"]) => ToolDoc
}

/** A tool's output schema: the domain catalog's entry for its name. */
export type McpToolOutput<N extends McpToolName> = (typeof McpToolOutputs)[N]

/**
 * One action of a tool family: what a tool of its own would declare, less what the family holds
 * for all of them (name, title, audience, scope, phrases). Every action of a family changes data.
 */
export interface McpToolActionSpec<
	P extends Schema.Codec<unknown, unknown, never, unknown>,
	O,
	R extends McpToolRequirements,
> {
	/** What this action does, in the family's description after `action=<name>:`. */
	readonly description: string
	readonly parameters: P
	readonly hints: McpToolHints
	/** In place of the family's, for an action a narrower key may run on its own. */
	readonly scopeFamily?: string | ReadonlyArray<string>
	readonly aliases?: Readonly<Record<string, string>>
	readonly valueAliases?: Readonly<Record<string, Readonly<Record<string, string>>>>
	readonly rejectUnknownKeys?: true
	readonly untrustedOutput?: true
	readonly handler: (params: P["Type"]) => Effect.Effect<O, McpToolError, R>
	readonly render: (output: O) => ToolDoc
}

/** What each action of a family returns. */
export type McpToolFamilyActionOutputs<N extends McpToolFamilyName> = (typeof McpToolFamilyActions)[N]

/**
 * One resource's write actions as a single tool: `manage_slo` with `action` create, update or
 * delete, where three tools would each repeat the resource's parameters in `tools/list`.
 */
export interface McpToolFamilySpec<N extends McpToolFamilyName> {
	readonly name: N
	readonly title: string
	/** What the family manages, in a sentence. Each action's own description follows it. */
	readonly description: string
	readonly audience?: McpToolAudience
	/** The scope every action needs, unless an action names its own. */
	readonly scopeFamily?: string | ReadonlyArray<string>
	/** For every action: a chat status line names the tool, not what it was asked to do. */
	readonly phrases: McpToolPhrases
}

export interface McpToolFamilyBuilder<N extends McpToolFamilyName> {
	/** Adds an action. Every action the domain catalog lists for the family must be added. */
	action<
		K extends keyof McpToolFamilyActionOutputs<N> & string,
		P extends Schema.Codec<unknown, unknown, never, unknown>,
		R extends McpToolRequirements,
	>(
		name: K,
		spec: McpToolActionSpec<P, Schema.Schema.Type<McpToolFamilyActionOutputs<N>[K]>, R>,
	): McpToolFamilyBuilder<N>
}

export interface McpToolRegistrar {
	define<
		P extends Schema.Codec<unknown, unknown, never, unknown>,
		N extends McpToolName,
		R extends McpToolRequirements,
	>(
		spec: McpToolSpec<P, N, R>,
	): void
	family<N extends McpToolFamilyName>(spec: McpToolFamilySpec<N>): McpToolFamilyBuilder<N>
}

/** `family` for a registrar that captures standalone tools only: a test reading one tool's spec. */
export const ignoreFamily = <N extends McpToolFamilyName>(): McpToolFamilyBuilder<N> => {
	const builder: McpToolFamilyBuilder<N> = { action: () => builder }
	return builder
}
