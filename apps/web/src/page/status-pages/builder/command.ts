import { StatusPagePreviewParams, V2StatusPageCreateParams } from "@maple/domain/http/v2"
import { Clock, Duration, Effect, Schema } from "effect"
import { Command, Dom, Mount } from "foldkit"
import { readIsAdmin } from "../../alerts/shared/commands"
import { listMonitors, saveMonitor } from "../../alerts/shared/uptime-commands"
import { createPage, previewPage } from "../shared/commands"
import { monitorPayloadFor } from "../shared/picker"
import { Message } from "./message"
import { SubmitMode } from "./model"

/** How long the builder waits after the last edit before it asks for a new preview. */
export const PREVIEW_DEBOUNCE_MS = 400

export const ReadBuilderClock = Command.define("ReadStatusPageBuilderClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchBuilderSession = Command.define("FetchStatusPageBuilderSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readIsAdmin, (isAdmin) => Message.CompletedFetchSession({ orgId, isAdmin })),
})

export const FetchBuilderMonitors = Command.define("FetchStatusPageBuilderMonitors", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchMonitors],
	execute: ({ key }) =>
		listMonitors.pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchMonitors({ key, result })),
		),
})

export const WaitBuilderPreview = Command.define("WaitStatusPageBuilderPreview", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedPreviewDebounce],
	execute: ({ generation }) =>
		Effect.as(
			Effect.sleep(Duration.millis(PREVIEW_DEBOUNCE_MS)),
			Message.ElapsedPreviewDebounce({ generation }),
		),
})

export const FetchBuilderPreview = Command.define("FetchStatusPagePreview", {
	args: { generation: Schema.Number, draft: StatusPagePreviewParams },
	messages: [Message.CompletedFetchPreview],
	execute: ({ generation, draft }) =>
		previewPage(draft).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchPreview({ generation, draft, result })),
		),
})

export const CreateBuilderMonitor = Command.define("CreateStatusPageMonitor", {
	args: { url: Schema.String },
	messages: [Message.CompletedCreateMonitor],
	execute: ({ url }) =>
		saveMonitor(null, monitorPayloadFor(url)).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateMonitor({ result })),
		),
})

export const CreateBuilderPage = Command.define("CreateStatusPage", {
	args: { mode: SubmitMode, payload: V2StatusPageCreateParams },
	messages: [Message.CompletedCreate],
	execute: ({ mode, payload }) =>
		createPage(payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreate({ mode, result })),
		),
})

export const FocusBuilderField = Command.define("FocusStatusPageBuilderField", {
	args: { id: Schema.String },
	messages: [Message.CompletedFocus],
	execute: ({ id }) =>
		Dom.focus(`#${CSS.escape(id)}`).pipe(Effect.ignore, Effect.as(Message.CompletedFocus())),
})

/** Focuses the element as it mounts, in the same render, so no keystroke lands elsewhere first. */
export const FocusNewRow = Mount.define("FocusStatusPageBuilderRow", {
	messages: [Message.CompletedFocus],
	execute: ({ element }) =>
		Effect.sync(() => (element instanceof HTMLElement ? element.focus() : undefined)).pipe(
			Effect.as(Message.CompletedFocus()),
		),
})
