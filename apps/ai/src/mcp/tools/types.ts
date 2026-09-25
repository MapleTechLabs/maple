import type { Effect } from "effect"
import { Schema } from "effect"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import type { McpToolRequirements } from "./runtime-requirements"
import type { ToolDoc } from "../lib/tool-doc"

class McpTenantError extends Schema.TaggedError<McpTenantError>()("@maple/mcp/errors/McpTenantError", {
	message: Schema.String,
}) {}

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

export type McpToolError =
	| McpTenantError
	| McpAuthMissingError
	| McpAuthInvalidError
	| McpAuthUnavailableError
	| McpInvalidTenantError
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
 * Who a tool is for.
 *
 * `public` tools are listed on and callable from every surface, the MCP transport
 * included. `internal` tools exist for Maple's own agents only — the chat agent
 * and the investigation pass — and the public transport neither lists nor
 * executes them. Declared at registration, so a tool cannot reach a third-party
 * MCP client by the mere fact of being in the registry: until this existed,
 * registering was publishing, and `sandbox_exec` shipped as a public tool.
 */
export type McpToolAudience = "public" | "internal"

/**
 * What a call is doing, in words a chat channel reads while it runs: `Running a query`, never
 * `run_sql`. Several where one tool is called repeatedly in a turn, so the status line does not
 * read as stuck; each one says only what the tool does, never why or what it found.
 */
export type McpToolPhrases = readonly [string, ...Array<string>]

/**
 * The surfaces an `internal` tool is offered on: Maple's own agents, answering someone who is
 * already inside the product.
 *
 * `bot` is deliberately absent. The chat-platform bot runs the same engine as `chat`, but its reply
 * lands in a channel that anyone who can post there reads, under an org-level actor with no Maple
 * user behind it. `sandbox_exec` alone is code execution against the org's repository; handing that
 * to a channel is not the same decision as handing it to a signed-in user's chat panel. The bot
 * therefore sees exactly the tools the public MCP transport sees — its mutations included, since
 * those are proposed and approved rather than executed, which code execution is not.
 */
const INTERNAL_SURFACES: ReadonlySet<McpToolSurface> = new Set<McpToolSurface>(["chat", "workflow"])

/** Whether a surface may see and call a tool of this audience. */
export const audienceAdmits = (audience: McpToolAudience, surface: McpToolSurface): boolean =>
	audience === "public" || INTERNAL_SURFACES.has(surface)

/**
 * A tool, declared as data: typed input, typed output, how the output reads to a model, and what
 * the call may do. The registry owns everything around it (decode, aliases, errors, encoding
 * the output, rendering the text, checking next calls), so no tool can do those differently.
 */
export interface McpToolSpec<
	P extends Schema.Codec<unknown, unknown, never, unknown>,
	O extends Schema.Codec<unknown, unknown, never, never>,
	R extends McpToolRequirements,
> {
	readonly name: string
	readonly description: string
	readonly parameters: P
	/** The result's schema: published as `outputSchema`, used to encode `structuredContent`. */
	readonly output: O
	readonly hints: McpToolHints
	/** Defaults to `public`. */
	readonly audience?: McpToolAudience
	readonly phrases: McpToolPhrases
	/** Retired parameter names mapped to their current name. Accepted, never published. */
	readonly aliases?: Readonly<Record<string, string>>
	readonly handler: (params: P["Type"]) => Effect.Effect<O["Type"], McpToolError, R>
	/** The model-facing text, derived from the output alone so the two cannot disagree. */
	readonly render: (output: O["Type"]) => ToolDoc
}

export interface McpToolRegistrar {
	define<
		P extends Schema.Codec<unknown, unknown, never, unknown>,
		O extends Schema.Codec<unknown, unknown, never, never>,
		R extends McpToolRequirements,
	>(
		spec: McpToolSpec<P, O, R>,
	): void
}
