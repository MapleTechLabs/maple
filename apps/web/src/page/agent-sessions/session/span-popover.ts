import type { AiSessionSpan } from "@maple/domain/http"
import {
	classifyAiSpan,
	type SessionToolResults,
	type SessionTurn,
	spanFailed,
	spanMessages,
	spanModel,
	spanToolCalls,
} from "@maple/agent-sessions"
import { formatDuration } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { iconButtonTooltipStyles } from "@maple/ui/styles/ui/icon-button"
import * as Tooltip from "../../../ui/tooltip"
import { AppRoute, hrefOf } from "../../../route"
import { orderedSearch } from "../../../route/tanstack-search"
import { button, linkButton } from "../../../ui/button"
import * as Dialog from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import * as ToggleGroup from "../../../ui/toggle-group"
import { Message } from "./message"
import type { SessionData } from "./derive"
import type { Model, SessionView, SpanDetailTab } from "./model"
import { CATEGORY_ICON, CATEGORY_TEXT } from "./span-visuals"
import { detailsSection, logsSection, metaStrip, toolCallsSection } from "./span-popover-details"
import { messagesSection, POPOVER_KEY } from "./span-popover-messages"
import { payloadCopyButton } from "./transcript-kit"

// The span popover over its expansion: one span
// inspected over the whole page, from the Overview's findings, the flow's nodes and the waterfall's rows.

type H = HtmlBuilder<Message>

export const SPAN_DIALOG_ID = "agent-session-span"

/** Each span opens on its own payload until the reader picks a tab: an error, messages, a tool call. */
export const activeTab = (
	model: Model,
	span: AiSessionSpan,
	toolResults: SessionToolResults,
): SpanDetailTab =>
	model.spanTab ??
	(spanFailed(span)
		? "details"
		: spanMessages(span).length > 0
			? "messages"
			: spanToolCalls(span, toolResults).length > 0
				? "tools"
				: "details")

export type SpanPopoverInputs = Readonly<{
	span: AiSessionSpan
	toolResults: SessionToolResults
	turnOrdinal: string | undefined
	/** Offered only where the reader is not already in the Traces view. */
	isTraceDoor: boolean
	timeZone: string
}>

/** `SpanExpansion`: the title and tab strip are fixed chrome; only the payload under them scrolls. */
const expansion = (
	h: H,
	model: Model,
	inputs: SpanPopoverInputs,
	closeTrigger: ReadonlyArray<ChildAttribute>,
): Html => {
	const { span, toolResults, timeZone } = inputs
	const messages = spanMessages(span)
	const toolCalls = spanToolCalls(span, toolResults)
	const active = activeTab(model, span, toolResults)
	const keyPrefix = `${POPOVER_KEY}:${span.spanId}`
	const section = (): Html => {
		switch (active) {
			case "details":
				return detailsSection(h, model, span, toolCalls, { timeZone, keyPrefix })
			case "messages":
				return messagesSection(h, model, messages, span, keyPrefix)
			case "tools":
				return toolCallsSection(h, model, span, toolCalls, keyPrefix)
			case "logs":
				return logsSection(h, model, span, timeZone)
		}
	}
	return h.div(
		[h.Class("flex min-h-0 min-w-0 grow flex-col text-left")],
		[
			titleRow(h, span, inputs, closeTrigger),
			h.div(
				[h.Class("flex shrink-0 flex-wrap items-center gap-2 border-border border-b px-5 pb-2")],
				[
					tabStrip(h, active, messages.length, toolCalls.length),
					h.div(
						[h.Class("ml-auto flex items-center gap-2")],
						[
							payloadCopyButton(h, model, {
								key: `${keyPrefix}:json`,
								value: JSON.stringify(span, null, 2),
								label: "Span JSON",
								idleLabel: "Copy JSON",
								iconSize: 12,
								variant: "outline",
								size: "sm",
								className: "h-6.5 gap-1.5 text-xs",
								hasTooltip: false,
							}),
							linkButton(
								h,
								{
									variant: "outline",
									size: "sm",
									className: "h-6.5 gap-1.5 text-xs",
									href: `${hrefOf(AppRoute.Trace({ traceId: span.traceId, search: {} }))}${orderedSearch(
										[
											["t", span.timestamp],
											["spanId", span.spanId],
										],
									)}`,
								},
								["Open in Traces", icon(h, "ExternalLinkIcon")],
							),
						],
					),
				],
			),
			h.div(
				[h.Class("min-h-0 grow overflow-y-auto overscroll-contain px-5 pb-6")],
				[metaStrip(h, model, span, timeZone), section()],
			),
		],
	)
}

/** The same wording the waterfall's headers use for the fallback partition. */
const turnOrdinal = (turn: SessionTurn): string =>
	`${turn.anchorKind === "trace" ? "Segment" : "Turn"} ${turn.index}`

/** The overlay of the Overview, Traces and Flow views; only the Flow names the span's turn. */
export const viewPopover = (
	h: H,
	model: Model,
	data: SessionData,
	view: SessionView,
	timeZone: string,
): Html => {
	const spanId = model.search.span
	const found =
		spanId === undefined
			? undefined
			: data.turns
					.flatMap((turn) => turn.spans.map((span) => ({ span, turn })))
					.find(({ span }) => span.spanId === spanId)
	return spanPopover(
		h,
		model,
		found === undefined
			? undefined
			: {
					span: found.span,
					toolResults: data.toolResults,
					turnOrdinal: view === "flow" ? turnOrdinal(found.turn) : undefined,
					isTraceDoor: view !== "trace",
					timeZone,
				},
	)
}

/** The overlay, open exactly while the active view has a span selected. */
export const spanPopover = (h: H, model: Model, inputs: SpanPopoverInputs | undefined): Html =>
	h.submodel({
		slotId: `${SPAN_DIALOG_ID}-close-tooltip`,
		model: model.closeTooltip,
		view: Tooltip.view,
		toParentMessage: (message: Tooltip.Message) => Message.GotCloseTooltipMessage({ message }),
		viewInputs: {
			// `IconButton`'s tooltip: its label, in the icon-button popup layout.
			toContent: () => ["Close span detail"],
			className: iconButtonTooltipStyles,
			toView: ({ trigger, portal }) =>
				h.submodel({
					slotId: SPAN_DIALOG_ID,
					model: model.spanDialog,
					view: DialogView.view,
					toParentMessage: (message: Dialog.Message) => Message.GotSpanDialogMessage({ message }),
					viewInputs: {
						hasTrigger: false,
						showCloseButton: false,
						hasTitle: false,
						hasDescription: false,
						isBottomStickOnMobile: false,
						className: cn(
							"h-[86vh] w-[86vw] max-w-none",
							"max-sm:h-[calc(100dvh-2rem)] max-sm:w-[calc(100vw-2rem)]",
						),
						toView: (dialog) => dialog.portal ?? h.empty,
						toContent: () =>
							inputs === undefined
								? []
								: [
										h.div(
											[
												h.DataAttribute("slot", "span-popover"),
												h.Class("flex min-h-0 min-w-0 grow flex-col"),
											],
											[expansion(h, model, inputs, trigger())],
										),
										...(portal === null ? [] : [portal]),
									],
					},
				}),
		},
	})

const tabCount = (h: H, count: number): ReadonlyArray<Html> =>
	count === 0
		? []
		: [h.span([h.Class("font-mono text-3xs text-muted-foreground tabular-nums")], [String(count)])]

const isSpanTab = (value: string): value is SpanDetailTab =>
	value === "details" || value === "messages" || value === "tools" || value === "logs"

const tabStrip = (h: H, active: SpanDetailTab, messageCount: number, toolCount: number): Html =>
	ToggleGroup.view(h, {
		model: ToggleGroup.init({ label: "Span detail", values: [active] }),
		toParentMessage: (message) =>
			// Clicking the pressed tab empties the group in Base UI; the tab stays put.
			Message.PickedSpanTab({
				tab:
					message._tag === "ClickedItem" && isSpanTab(message.value) && message.value !== active
						? message.value
						: null,
			}),
		items: [
			{ value: "details", label: "Details" },
			{ value: "messages", label: "Messages", children: ["Messages", ...tabCount(h, messageCount)] },
			{ value: "tools", label: "Tool calls", children: ["Tool calls", ...tabCount(h, toolCount)] },
			{ value: "logs", label: "Logs" },
		],
		size: "xs",
	})

const titleRow = (
	h: H,
	span: AiSessionSpan,
	{ turnOrdinal, isTraceDoor }: SpanPopoverInputs,
	closeTrigger: ReadonlyArray<ChildAttribute>,
): Html => {
	const category = classifyAiSpan(span)
	const isErrored = spanFailed(span)
	const subtitle = [turnOrdinal, spanModel(span), formatDuration(span.durationMs)]
		.filter((part): part is string => part !== undefined)
		.join(" · ")
	return h.div(
		[h.Class("flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 px-5 pt-4 pb-3")],
		[
			icon(h, isErrored ? "CircleXmarkIcon" : CATEGORY_ICON[category], {
				size: 14,
				className: cn("shrink-0", isErrored ? "text-severity-error" : CATEGORY_TEXT[category]),
				attributes: [h.AriaHidden(true)],
			}),
			h.span([h.Class("min-w-0 truncate font-medium font-mono text-sm")], [span.spanName]),
			...(subtitle === "" ? [] : [h.span([h.Class("text-muted-foreground text-xs")], [subtitle])]),
			h.div(
				[h.Class("ml-auto flex items-center gap-2")],
				[
					...(isTraceDoor
						? [
								button(
									h,
									{
										variant: "outline",
										size: "xs",
										attributes: [h.OnClick(Message.ClickedOpenInTraceView())],
									},
									["Open in Traces view"],
								),
							]
						: []),
					iconButton(
						h,
						{
							label: "Close span detail",
							hasTooltip: false,
							attributes: [...closeTrigger, h.OnClick(Message.ClickedCloseSpan())],
						},
						[icon(h, "XmarkIcon")],
					),
				],
			),
		],
	)
}
