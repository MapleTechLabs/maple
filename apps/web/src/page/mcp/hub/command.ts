import { MCP_CLIENT_KINDS } from "@maple/domain/mcp-clients"
import {
	getMcpOverview,
	getMcpServers,
	getMcpSession,
	getMcpSessions,
	getMcpTool,
} from "@maple/web-data/warehouse/mcp"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { resolveWindow } from "../../../data/time-range"
import { SEMCONV_MCP_URL } from "../view-kit"
import { Message, RequestMode } from "./message"

const Window = { startTime: Schema.String, endTime: Schema.String, bucketSeconds: Schema.Number }
const Selection = {
	client: Schema.UndefinedOr(Schema.String),
	kind: Schema.UndefinedOr(Schema.Literals(MCP_CLIENT_KINDS)),
}

export const ResolveWindow = Command.define("ResolveMcpWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.UndefinedOr(Schema.String),
		endTime: Schema.UndefinedOr(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				nowMs,
				mode,
			}),
		),
})

export const FetchServers = Command.define("FetchMcpServers", {
	args: { key: Schema.String, ...Window },
	messages: [Message.CompletedFetchServers],
	execute: ({ key, ...data }) =>
		getMcpServers({ data }).pipe(
			Effect.map((response) => ({ servers: response.servers })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchServers({ key, result })),
		),
})

export const FetchOverview = Command.define("FetchMcpOverview", {
	args: {
		key: Schema.String,
		...Window,
		...Selection,
		service: Schema.String,
		search: Schema.UndefinedOr(Schema.String),
		failingOnly: Schema.Boolean,
	},
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, ...data }) =>
		getMcpOverview({ data }).pipe(
			Effect.map((response) => ({ ...response })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

export const FetchTool = Command.define("FetchMcpTool", {
	args: {
		key: Schema.String,
		...Window,
		...Selection,
		service: Schema.String,
		tool: Schema.String,
		failingOnly: Schema.Boolean,
	},
	messages: [Message.CompletedFetchTool],
	execute: ({ key, ...data }) =>
		getMcpTool({ data }).pipe(
			Effect.map((response) => ({ ...response })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTool({ key, result })),
		),
})

export const FetchSessions = Command.define("FetchMcpSessions", {
	args: {
		key: Schema.String,
		...Window,
		...Selection,
		service: Schema.String,
		search: Schema.UndefinedOr(Schema.String),
		failingOnly: Schema.Boolean,
	},
	messages: [Message.CompletedFetchSessions],
	execute: ({ key, ...data }) =>
		getMcpSessions({ data }).pipe(
			Effect.map((response) => ({ ...response })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSessions({ key, result })),
		),
})

export const FetchSession = Command.define("FetchMcpSession", {
	args: { key: Schema.String, ...Window, service: Schema.String, sessionId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ key, ...data }) =>
		getMcpSession({ data }).pipe(
			Effect.map((response) => ({ ...response })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSession({ key, result })),
		),
})

export const DebounceSearch = Command.define("DebounceMcpSearch", {
	args: { version: Schema.Number },
	messages: [Message.ElapsedSearchDebounce],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(300)), Message.ElapsedSearchDebounce({ version })),
})

export const CompleteReloadSpin = Command.define("CompleteMcpReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})

/** The empty state's "Instrument an MCP server": the MCP conventions, in a new tab. */
export const OpenMcpConventions = Command.define("OpenMcpConventions", {
	args: {},
	messages: [Message.Ignored],
	execute: () =>
		Effect.sync(() => {
			window.open(SEMCONV_MCP_URL, "_blank", "noopener,noreferrer")
			return Message.Ignored()
		}),
})
