import type { AiSessionSpan } from "@maple/domain/http"
import { SpanId, TraceId } from "@maple/domain"
import { spanMessages } from "@maple/agent-sessions"
import { Effect, Option, Schema } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import * as Dialog from "../../../ui/dialog"
import * as Tooltip from "../../../ui/tooltip"
import type { PageContext, PageReturn } from "../../contract"
import { FetchSpanDetail, FetchSpanLogs, LOG_LIMIT } from "../../traces/detail/span-panel/command"
import type { Message as SpanPanelMessage } from "../../traces/detail/span-panel/message"
import type { PanelState } from "../../traces/detail/span-panel/model"
import { sessionData, viewOf } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { activeTab } from "./span-popover"
import { POPOVER_KEY, popoverMarkdown } from "./span-popover-messages"

// The span popover's state: open exactly while a view that has the overlay has `?span=` set, its
// lazy Details and Logs reads made once their tab is open, its disclosures reset per span.

type Return = PageReturn<Model, Message>

export const freshSpanPanel = (): PanelState => ({
	detail: Keyed.idle(),
	logs: Keyed.idle(),
	copies: {},
	openIds: [],
	isErrorExpanded: false,
})

const OVERLAY_VIEWS = new Set(["overview", "trace", "flow"])

export const CLOSE_TOOLTIP_ID = "agent-session-span-close"

/** The span the overlay shows: selected in a view that draws it, and among the session's spans. */
export const popoverSpan = (model: Model): AiSessionSpan | undefined => {
	const spanId = model.search.span
	if (spanId === undefined || !OVERLAY_VIEWS.has(viewOf(model.search.view))) return undefined
	if (!AsyncData.hasData(model.firstPage.data)) return undefined
	return sessionData(model)
		.turns.flatMap((turn) => turn.spans)
		.find((span) => span.spanId === spanId)
}

export const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, spanDialog: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotSpanDialogMessage({ message }),
	),
})

const notPopover = (key: string) => !key.startsWith(`${POPOVER_KEY}:`)

/** A new span starts from the defaults: no reads, no disclosures, nothing measured. */
const forSpan = (model: Model, spanId: string): Model =>
	model.spanPanelId === spanId
		? model
		: {
				...model,
				spanPanelId: spanId,
				spanPanel: freshSpanPanel(),
				openRows: model.openRows.filter(notPopover),
				clampedBodies: model.clampedBodies.filter(notPopover),
			}

const decodeTraceId = Schema.decodeUnknownOption(TraceId)
const decodeSpanId = Schema.decodeUnknownOption(SpanId)

const toPanel = (message: SpanPanelMessage) => Message.GotSpanPanelMessage({ message })

/** The open tab's lazy read: `spanDetail` for Details, the span's logs for Logs, each once per span. */
const readFor = (model: Model, context: PageContext, span: AiSessionSpan): Return => {
	const tab = activeTab(model, span, sessionData(model).toolResults)
	const ids = Option.all({ traceId: decodeTraceId(span.traceId), spanId: decodeSpanId(span.spanId) })
	if (Option.isNone(ids)) return { model }
	const { traceId, spanId } = ids.value
	if (tab === "details") {
		const key = requestKey(context.orgId, "getSpanDetail", {
			data: { traceId, spanId, timestamp: span.timestamp },
		})
		return Option.match(Keyed.request(model.spanPanel.detail, key, "Load"), {
			onNone: () => ({ model }),
			onSome: (detail) => ({
				model: { ...model, spanPanel: { ...model.spanPanel, detail } },
				commands: Command.mapMessages(
					[FetchSpanDetail({ key, traceId, spanId, timestamp: span.timestamp })],
					toPanel,
				),
			}),
		})
	}
	if (tab !== "logs") return { model }
	const key = requestKey(context.orgId, "listLogs", { data: { traceId, spanId, limit: LOG_LIMIT } })
	return Option.match(Keyed.request(model.spanPanel.logs, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (logs) => ({
			model: { ...model, spanPanel: { ...model.spanPanel, logs } },
			commands: Command.mapMessages([FetchSpanLogs({ key, traceId, spanId })], toPanel),
		}),
	})
}

const withCommands = (result: Return, next: Return): Return => ({
	...result,
	model: next.model,
	commands: [...(result.commands ?? []), ...(next.commands ?? [])],
})

/** After every step: open or close the overlay to match the URL, and make the open tab's read. */
export const followPopover =
	(context: PageContext) =>
	(result: Return): Return => {
		const span = popoverSpan(result.model)
		if (span === undefined) {
			if (!result.model.spanDialog.isOpen) return result
			// The Close button leaves with the popup, so its tooltip goes too.
			const shut = { ...result.model, closeTooltip: Tooltip.init(CLOSE_TOOLTIP_ID) }
			return withCommands(result, liftDialog(shut, Dialog.close(shut.spanDialog)))
		}
		const model = forSpan(result.model, span.spanId)
		const opened = model.spanDialog.isOpen ? { model } : liftDialog(model, Dialog.open(model.spanDialog))
		return withCommands(withCommands(result, opened), readFor(opened.model, context, span))
	}

/** Whether the focused element is keyboard-focused: a press's focus does not open a tooltip. */
export const CheckCloseFocus = Command.define("CheckAgentSessionCloseFocus", {
	args: { triggerId: Schema.String },
	messages: [Message.CheckedCloseFocus],
	execute: ({ triggerId }) =>
		Effect.sync(() =>
			Message.CheckedCloseFocus({
				triggerId,
				isFocusVisible: document.getElementById(triggerId)?.matches(":focus-visible") === true,
			}),
		),
})

const liftTooltip = (model: Model, step: ReturnType<typeof Tooltip.update>): Return => ({
	model: { ...model, closeTooltip: step.model },
	commands: Command.mapMessages(step.commands ?? [], (message) =>
		Message.GotCloseTooltipMessage({ message }),
	),
})

/** The Close button's tooltip; its focus opens it only once `:focus-visible` confirms it. */
export const stepCloseTooltip = (model: Model, message: Tooltip.Message): Return =>
	message._tag === "FocusedTrigger"
		? { model, commands: [CheckCloseFocus({ triggerId: message.triggerId })] }
		: liftTooltip(model, Tooltip.update(model.closeTooltip, message))

export const checkedCloseFocus = (model: Model, triggerId: string, isFocusVisible: boolean): Return =>
	isFocusVisible
		? liftTooltip(
				model,
				Tooltip.update(
					model.closeTooltip,
					Tooltip.Message.CheckedFocusVisible({ triggerId, isFocusVisible: true }),
				),
			)
		: { model }

/** The Messages tab's markdown bodies, when that tab is the one open. */
export const popoverMarkdownTexts = (model: Model): ReadonlyArray<string> => {
	const span = popoverSpan(model)
	if (span === undefined || activeTab(model, span, sessionData(model).toolResults) !== "messages") return []
	return popoverMarkdown(model, spanMessages(span), `${POPOVER_KEY}:${span.spanId}`)
}
