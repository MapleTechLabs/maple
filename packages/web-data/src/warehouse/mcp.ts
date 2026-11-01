// The warehouse reads behind the MCP hub (`/mcp-servers`, a server's overview, its tool page).
// The API already returns epoch-ms times and nanosecond durations, so these pass through.

import { Effect, Schema } from "effect"
import { McpClientKind, McpOverviewRequest, McpServersRequest, McpToolRequest } from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

const text = Schema.String.check(Schema.isMinLength(1))

const McpWindowInput = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
	bucketSeconds: Schema.Number,
})

const McpOverviewInput = Schema.Struct({
	...McpWindowInput.fields,
	service: text,
	client: Schema.optional(text),
	kind: Schema.optional(McpClientKind),
	search: Schema.optional(text),
	failingOnly: Schema.optional(Schema.Boolean),
})
export type McpOverviewInput = typeof McpOverviewInput.Type

const McpToolInput = Schema.Struct({
	...McpWindowInput.fields,
	service: text,
	tool: text,
	client: Schema.optional(text),
	kind: Schema.optional(McpClientKind),
	failingOnly: Schema.optional(Schema.Boolean),
})
export type McpToolInput = typeof McpToolInput.Type

/** Absent optionals stay absent on the wire. */
const selection = (input: { client?: string; kind?: McpClientKind }) => ({
	...(input.client !== undefined && { client: input.client }),
	...(input.kind !== undefined && { kind: input.kind }),
})

export const getMcpServers = Effect.fn("Mcp.servers")(function* ({
	data,
}: {
	data: typeof McpWindowInput.Type
}) {
	const input = yield* decodeInput(McpWindowInput, data, "mcpServers")
	return yield* runWarehouseQuery("mcpServers", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.mcpInternal.servers({ payload: new McpServersRequest(input) })
		}),
	)
})

export const getMcpOverview = Effect.fn("Mcp.overview")(function* ({ data }: { data: McpOverviewInput }) {
	const input = yield* decodeInput(McpOverviewInput, data, "mcpOverview")
	return yield* runWarehouseQuery("mcpOverview", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.mcpInternal.overview({
				payload: new McpOverviewRequest({
					service: input.service,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
					...selection(input),
					...(input.search !== undefined && { search: input.search }),
					...(input.failingOnly === true && { failingOnly: true }),
				}),
			})
		}),
	)
})

export const getMcpTool = Effect.fn("Mcp.tool")(function* ({ data }: { data: McpToolInput }) {
	const input = yield* decodeInput(McpToolInput, data, "mcpTool")
	return yield* runWarehouseQuery("mcpTool", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.mcpInternal.tool({
				payload: new McpToolRequest({
					service: input.service,
					tool: input.tool,
					startTime: input.startTime,
					endTime: input.endTime,
					bucketSeconds: input.bucketSeconds,
					...selection(input),
					...(input.failingOnly === true && { failingOnly: true }),
				}),
			})
		}),
	)
})
