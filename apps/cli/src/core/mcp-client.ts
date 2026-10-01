// The CLI's second remote transport: Maple's hosted MCP server, called with
// the same `maple_ak_…` key `maple auth login` stores.
//
// v2 is the stable resource API and stays the first choice. Some commands ask
// for something v2 deliberately does not model (raw SQL, attribute discovery,
// ranked aggregates, period comparison), and the MCP tools already answer
// those with the same `@maple/query-engine/observability` functions local mode
// runs. Each tool's `structuredContent` is decoded with its published output
// schema (`@maple/domain/mcp-outputs`), so a drift in the server's contract
// fails loudly here instead of rendering a wrong table.
//
// The server's transport is stateless: one POST carries one `tools/call`, no
// `initialize` or session id needed.

import { Clock, Effect, Schema } from "effect"
import { HttpClient, HttpClientRequest } from "effect/unstable/http"
import { McpToolOutputs, type McpToolName } from "@maple/domain/mcp-outputs"
import { WarehouseQueryError } from "@maple/domain/http/warehouse-errors"
import { debugLog } from "../lib/debug"
import { CliUsageError } from "../lib/errors"

/** The workspace refused the stored key (401/403). `lib/failure.ts` reads the tag. */
export class RemoteToolUnauthorized extends Schema.TaggedError<RemoteToolUnauthorized>()(
	"@maple/cli/RemoteToolUnauthorized",
	{ message: Schema.String },
) {}

/** The tool ran and reported a failure, or its answer did not match its schema. */
export class RemoteToolFailure extends Schema.TaggedError<RemoteToolFailure>()(
	"@maple/cli/RemoteToolFailure",
	{ tool: Schema.String, message: Schema.String },
) {}

export type McpToolOutput<K extends McpToolName> = (typeof McpToolOutputs)[K]["Type"]

export interface MapleMcpClient {
	readonly call: <K extends McpToolName>(
		tool: K,
		args: Record<string, unknown>,
	) => Effect.Effect<McpToolOutput<K>, CliUsageError | WarehouseQueryError>
}

const ToolResult = Schema.Struct({
	content: Schema.optionalKey(
		Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optionalKey(Schema.String) })),
	),
	structuredContent: Schema.optionalKey(Schema.Unknown),
	isError: Schema.optionalKey(Schema.Boolean),
})

const JsonRpcResponse = Schema.Struct({
	id: Schema.optionalKey(Schema.Unknown),
	result: Schema.optionalKey(ToolResult),
	error: Schema.optionalKey(Schema.Struct({ code: Schema.Number, message: Schema.String })),
})

const decodeBody = Schema.decodeUnknownOption(
	Schema.fromJsonString(Schema.Union([JsonRpcResponse, Schema.Array(JsonRpcResponse)])),
)

// The server appends this for agents; a terminal user cannot act on it.
const FEEDBACK_HINT = /\n?If this looks like a bug in Maple.*$/s

const textOf = (result: typeof ToolResult.Type): string =>
	(result.content ?? [])
		.map((part) => part.text ?? "")
		.join("\n")
		.replace(FEEDBACK_HINT, "")
		.trim()

/** Arguments without `undefined` values, so an unset flag sends nothing. */
const definedArgs = (args: Record<string, unknown>): Record<string, unknown> =>
	Object.fromEntries(Object.entries(args).filter(([, value]) => value !== undefined))

const CALL_ID = 1

export const makeMcpClient = (apiUrl: string, token: string) =>
	Effect.map(HttpClient.HttpClient, (http): MapleMcpClient => {
		const endpoint = `${apiUrl.replace(/\/$/, "")}/mcp`
		const call = <K extends McpToolName>(tool: K, args: Record<string, unknown>) => {
			const queryError = (message: string, cause: unknown) =>
				new WarehouseQueryError({ message, pipeName: tool, cause })
			const failure = (message: string) => queryError(message, new RemoteToolFailure({ tool, message }))
			const request = HttpClientRequest.post(endpoint).pipe(
				HttpClientRequest.bearerToken(token),
				HttpClientRequest.setHeader("accept", "application/json, text/event-stream"),
				HttpClientRequest.bodyJsonUnsafe({
					jsonrpc: "2.0",
					id: CALL_ID,
					method: "tools/call",
					params: { name: tool, arguments: definedArgs(args) },
				}),
			)
			return Effect.gen(function* () {
				const startedAtMs = yield* Clock.currentTimeMillis
				const response = yield* http
					.execute(request)
					.pipe(
						Effect.mapError((error) =>
							queryError(`could not reach ${endpoint}: ${error.message}`, error),
						),
					)
				const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""))
				debugLog(
					`remote tool ${tool} · ${response.status} · ${(yield* Clock.currentTimeMillis) - startedAtMs}ms`,
					JSON.stringify(definedArgs(args)),
				)
				if (response.status === 401 || response.status === 403) {
					const message = `the workspace refused the credentials (HTTP ${response.status})`
					return yield* queryError(message, new RemoteToolUnauthorized({ message }))
				}
				if (response.status < 200 || response.status >= 300) {
					return yield* failure(`${endpoint} answered HTTP ${response.status}`)
				}
				const decoded = decodeBody(body)
				if (decoded._tag === "None")
					return yield* failure(`${endpoint} returned a malformed response`)
				const envelope = Array.isArray(decoded.value)
					? decoded.value.find((r) => r.id === CALL_ID)
					: decoded.value
				if (envelope?.error !== undefined) return yield* failure(envelope.error.message)
				const result = envelope?.result
				if (result === undefined) return yield* failure(`${tool} returned no result`)
				if (result.isError === true) {
					const text = textOf(result)
					// The registry phrases caller mistakes as "Invalid input…"/"Invalid parameters…".
					return yield* /^Invalid (input|parameters)/.test(text)
						? new CliUsageError({ message: text.split("\n")[0]! })
						: failure(text.split("\n")[0] || `${tool} failed`)
				}
				return yield* Schema.decodeUnknownEffect(McpToolOutputs[tool])(result.structuredContent).pipe(
					Effect.mapError(() =>
						failure(
							`${tool} answered in a shape this CLI does not understand; run \`maple update\``,
						),
					),
				)
			})
		}
		return { call }
	})
