import { ProductEventsFunnelWidgetParams, ProductEventsPathsWidgetParams } from "@maple/query-model"
import {
	getProductEventNames,
	getProductEventsFunnelWidget,
	getProductEventsPathsWidget,
} from "@maple/web-data/warehouse/product-events"
import { getWebAnalyticsBreakdowns, WebAnalyticsFilterFields } from "@maple/web-data/warehouse/web-analytics"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { resolveWindow } from "../../data/time-range"
import { Message, RequestMode, SlotName } from "./message"

// The page's reads. Every fetch answers `CompletedFetch` with its slot and key; the request itself
// is the web-data function, with the input it was keyed on.

export const ResolveWindow = Command.define("ResolveProductAnalyticsWindow", {
	args: {
		mode: RequestMode,
		startTime: Schema.optional(Schema.String),
		endTime: Schema.optional(Schema.String),
		preset: Schema.String,
		timeZone: Schema.String,
	},
	messages: [Message.CompletedResolveWindow],
	execute: ({ mode, startTime, endTime, preset, timeZone }) =>
		Effect.map(Clock.currentTimeMillis, (nowMs) =>
			Message.CompletedResolveWindow({
				window: resolveWindow({ startTime, endTime, preset, snap: mode === "Load", timeZone }, nowMs),
				mode,
			}),
		),
})

const Window = { startTime: Schema.String, endTime: Schema.String }

const define = <Fields extends Schema.Struct.Fields, R>(
	name: string,
	fields: Fields,
	run: (input: Schema.Struct<Fields>["Type"]) => Effect.Effect<unknown, unknown, R>,
) =>
	Command.define(name, {
		args: { slot: SlotName, key: Schema.String, input: Schema.Struct(fields) },
		messages: [Message.CompletedFetch],
		execute: ({ slot, key, input }) =>
			run(input).pipe(
				Effect.mapError(toLoadFailure),
				Effect.result,
				Effect.map((result) => Message.CompletedFetch({ slot, key, result })),
			),
	})

export const FetchBreakdowns = define(
	"FetchProductAnalyticsBreakdowns",
	{ ...Window, ...WebAnalyticsFilterFields, limitPerDimension: Schema.optional(Schema.Number) },
	(data) => getWebAnalyticsBreakdowns({ data }),
)
export const FetchEventNames = define(
	"FetchProductEventNames",
	{ ...Window, ...WebAnalyticsFilterFields, limit: Schema.optional(Schema.Number) },
	(data) => getProductEventNames({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchFunnel = define(
	"FetchProductAnalyticsFunnel",
	{ ...Window, ...ProductEventsFunnelWidgetParams.fields },
	(data) => getProductEventsFunnelWidget({ data }).pipe(Effect.map((response) => response.data)),
)
export const FetchPaths = define(
	"FetchProductAnalyticsPaths",
	{ ...Window, ...ProductEventsPathsWidgetParams.fields },
	(data) => getProductEventsPathsWidget({ data }).pipe(Effect.map((response) => response.data)),
)

/** Typing in a step holds the URL back this long, so a run waits for the name. */
const TYPING_PAUSE = Duration.millis(450)

export const WaitForTypingPause = Command.define("WaitForProductAnalyticsTypingPause", {
	args: { version: Schema.Number },
	messages: [Message.PausedTyping],
	execute: ({ version }) => Effect.as(Effect.sleep(TYPING_PAUSE), Message.PausedTyping({ version })),
})

export const CompleteReloadSpin = Command.define("CompleteProductAnalyticsReloadSpin", {
	args: { version: Schema.Number },
	messages: [Message.CompletedReloadSpin],
	execute: ({ version }) =>
		Effect.as(Effect.sleep(Duration.millis(600)), Message.CompletedReloadSpin({ version })),
})
