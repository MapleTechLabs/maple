import type { AiSessionSpan } from "@maple/domain/http"
import {
	classifyAiSpan,
	formatCost,
	payload,
	spanCost,
	spanFailed,
	type SpanToolCall,
	spanTtftMs,
} from "@maple/agent-sessions"
import { formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import { formatDuration, formatNumber } from "@maple/ui/lib/format"
import { shortId } from "@maple/ui/lib/ids"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { emptyMessage } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { keyValue, keyValueList } from "../../../ui/key-value"
import { skeleton } from "../../../ui/skeleton"
import { truncatedText } from "../../../ui/truncated-text"
import type { Message as PanelMessage } from "../../traces/detail/span-panel/message"
import type { PanelState } from "../../traces/detail/span-panel/model"
import { attributesSection } from "../../traces/detail/span-panel/attributes"
import { copyableValue } from "../../traces/detail/span-panel/copy"
import { errorSection } from "../../traces/detail/span-panel/error-section"
import { spanLogs } from "../../traces/detail/span-panel/view-tabs"
import { Message as SessionMessage, type Message } from "./message"
import type { Model } from "./model"
import { payloadCard } from "./span-popover-messages"
import { toolIo } from "./tool-io"

// The span expansion's Tool calls, Details and Logs tabs.
// Details and Logs draw the trace span panel's parts over the popover's own `PanelState`.

type H = HtmlBuilder<Message>
type P = HtmlBuilder<PanelMessage>

/** One invocation as one card: the call and its result drawn together by `ToolIo`. */
const toolCallCard = (
	h: H,
	model: Model,
	call: SpanToolCall,
	options: Readonly<{ isFailed: boolean; statusCode: string; keyPrefix: string }>,
): Html =>
	h.div(
		[h.Class("min-w-0 overflow-hidden rounded-md border border-border-subtle")],
		[
			h.div(
				[h.Class("flex items-center gap-2 bg-surface-sunken px-2.5 py-1.5")],
				[
					h.span([h.AriaHidden(true), h.Class("size-1.5 shrink-0 rounded-xs bg-chart-4")], []),
					h.span([h.Class("shrink-0 font-medium font-mono text-chart-4 text-xs")], ["tool"]),
					...(call.name === undefined
						? []
						: [
								truncatedText(h, {
									text: call.name,
									mono: true,
									className: "text-foreground text-xs",
								}),
							]),
					...(call.id === undefined
						? []
						: [
								truncatedText(h, {
									text: call.id,
									mono: true,
									className: "ml-auto max-w-40 shrink-0 text-2xs text-foreground-subtle",
								}),
							]),
				],
			),
			...(call.description === undefined
				? []
				: [
						h.p(
							[
								h.Class(
									"border-border-subtle border-t px-2.5 py-1.5 text-muted-foreground text-xs",
								),
							],
							[call.description],
						),
					]),
			...toolIo(h, model, {
				args: payload(call.argumentsText),
				result: payload(call.resultText),
				isFailed: options.isFailed,
				resultMeta: options.isFailed ? `span status ${options.statusCode}` : undefined,
				missingResultNote: "not captured, so whether the call succeeded is unknown.",
				keyPrefix: options.keyPrefix,
			}),
		],
	)

/** The failure of a span with no status message: the pills name the attributes it was read from. */
const failureBanner = <M>(b: HtmlBuilder<M>, span: AiSessionSpan): Html => {
	const errorType = span.genAi.errorType
	const responseStatus = span.genAi.responseStatus
	const hasErrorType = errorType !== undefined && errorType !== ""
	const pill = (text: string) =>
		badge(b, { pill: true, size: "xs", mono: true, className: TONE_SOFT.crit }, [text])
	return b.div(
		[
			b.Class(
				"flex flex-col gap-1.5 rounded-md border border-severity-error-a4 bg-severity-error-a1 p-3",
			),
		],
		[
			b.div(
				[b.Class("flex flex-wrap items-center gap-2")],
				[
					icon(b, "CircleWarningIcon", { size: 14, className: "shrink-0 text-severity-error" }),
					b.span([b.Class("font-medium text-ui text-severity-error")], ["This call failed"]),
					...(span.statusCode === "Error" ? [pill("span status Error")] : []),
					...(hasErrorType ? [pill(`error.type ${errorType}`)] : []),
					...(span.statusCode !== "Error" && !hasErrorType && responseStatus !== undefined
						? [pill(`response.status ${responseStatus}`)]
						: []),
				],
			),
			b.p(
				[b.Class("text-muted-foreground text-xs leading-relaxed")],
				[
					"The pills here are the attributes the failure was read from; the span carries no status message.",
				],
			),
		],
	)
}

type PanelInputs = Readonly<{ span: AiSessionSpan; timeZone: string }>

/** A failed span leads with its failure: the status message, or the attributes it was read from. */
const failureView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>((state, { span }, p) =>
	span.statusMessage === ""
		? failureBanner(p, span)
		: errorSection(p, state, {
				message: span.statusMessage,
				badge: span.genAi.errorType,
				prompt: {
					serviceName: span.serviceName,
					operation: span.spanName,
					attributes: Option.match(AsyncData.getData(state.detail.data), {
						onNone: () => ({}),
						onSome: (detail) => detail.spanAttributes,
					}),
				},
				className: "mx-0 my-0",
			}),
)

/** Identity and timing, every value click-to-copy: the trace panel's "Span" card. */
const identityRows = (p: P, state: PanelState, span: AiSessionSpan, timeZone: string): Html => {
	const ttftMs = spanTtftMs(span)
	const rows: ReadonlyArray<readonly [string, string | undefined]> = [
		["Started", formatTimestampInTimezone(span.timestamp, { timeZone, withMilliseconds: true })],
		["Duration", formatDuration(span.durationMs)],
		["Time to first token", ttftMs === undefined ? undefined : formatDuration(ttftMs)],
		[
			"Status",
			span.statusMessage === "" ? span.statusCode : `${span.statusCode} · ${span.statusMessage}`,
		],
		["Kind", span.spanKind],
		["Service", span.serviceName],
		["Span ID", span.spanId],
		["Trace ID", span.traceId],
		["Parent span ID", span.parentSpanId === "" ? undefined : span.parentSpanId],
	]
	return keyValueList(
		p,
		{ layout: "grid", divided: true, className: "rounded-md border border-border-subtle px-2.5" },
		rows.flatMap(([label, value]) =>
			value === undefined
				? []
				: [
						keyValue(p, { label, mono: true }, [
							copyableValue(
								p,
								state,
								{ id: `identity:${label}`, value, className: "min-w-0" },
								[p.span([p.Class("block truncate")], [value])],
							),
						]),
					],
		),
	)
}

const identityView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>(
	(state, { span, timeZone }, p) => identityRows(p, state, span, timeZone),
)

/** The span attributes once the lazy `spanDetail` read lands; its skeleton and failure meanwhile. */
const spanAttributesView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>((state, _inputs, p) =>
	AsyncData.matchData(state.detail.data, {
		onEmpty: () =>
			p.div(
				[p.Class("flex flex-col gap-2")],
				[
					skeleton(p, "h-4 w-32"),
					skeleton(p, "h-24 w-full"),
					skeleton(p, "h-4 w-32"),
					skeleton(p, "h-24 w-full"),
				],
			),
		onFailure: () => emptyMessage(p, {}, ["Couldn't load this span's full attributes."]),
		onData: (detail) =>
			attributesSection(p, state, "span", detail.spanAttributes, "Span attributes", {
				isFilterable: false,
			}),
	}),
)

const resourceAttributesView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>(
	(state, _inputs, p) =>
		AsyncData.matchData(state.detail.data, {
			onEmpty: () => p.empty,
			onFailure: () => p.empty,
			onData: (detail) =>
				attributesSection(p, state, "resource", detail.resourceAttributes, "Resource attributes", {
					isFilterable: false,
				}),
		}),
)

/** `LogsSection`: the trace panel's span logs, read once the tab is open. */
const logsView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>((state, { timeZone }, p) =>
	p.div([p.Class("overflow-hidden rounded-md border border-border-subtle")], [spanLogs(p, state, timeZone)]),
)

/** The call's own settings and identity, shown only where the span reported them. */
const metaStripView = Submodel.defineView<PanelState, PanelMessage, PanelInputs>(
	(state, { span, timeZone }, p) => {
		const ttftMs = spanTtftMs(span)
		const cost = spanCost(span)
		const pairs: ReadonlyArray<readonly [string, Html | string | number | undefined]> = [
			["provider", span.genAi.providerName],
			["started", formatTimestampInTimezone(span.timestamp, { timeZone, withMilliseconds: true })],
			["ttft", ttftMs === undefined ? undefined : formatDuration(ttftMs)],
			[
				"max_tokens",
				span.genAi.requestMaxTokens === undefined
					? undefined
					: formatNumber(span.genAi.requestMaxTokens),
			],
			["temperature", span.genAi.requestTemperature],
			["cost", cost === undefined ? undefined : p.span([p.Class("text-primary")], [formatCost(cost)])],
		]
		return p.div(
			[p.Class("flex flex-wrap items-baseline gap-x-4 gap-y-1 py-2.5")],
			[
				...pairs.flatMap(([label, value]) =>
					value === undefined
						? []
						: [
								p.span(
									[p.Class("flex items-baseline gap-1.5")],
									[
										p.span([p.Class("text-2xs text-muted-foreground")], [label]),
										p.span(
											[p.Class("font-mono text-foreground text-xs")],
											[typeof value === "number" ? String(value) : value],
										),
									],
								),
							],
				),
				p.span(
					[
						p.Class(
							"ml-auto flex items-baseline gap-1.5 font-mono text-2xs text-foreground-subtle",
						),
					],
					[
						copyableValue(p, state, { id: "meta:span", value: span.spanId, label: "Span ID" }, [
							"span ",
							span.spanId,
						]),
						p.span([p.AriaHidden(true)], ["·"]),
						copyableValue(
							p,
							state,
							{ id: "meta:trace", value: span.traceId, label: "Trace ID" },
							["trace ", shortId(span.traceId, "trace"), "…", span.traceId.slice(-4)],
						),
					],
				),
			],
		)
	},
)

export const metaStrip = (h: H, model: Model, span: AiSessionSpan, timeZone: string): Html =>
	panelPart(h, model, "meta", metaStripView, { span, timeZone })

const panelPart = (
	h: H,
	model: Model,
	slotId: string,
	view: typeof identityView,
	inputs: PanelInputs,
): Html =>
	h.submodel({
		slotId: `agent-session-span-${slotId}`,
		model: model.spanPanel,
		view,
		viewInputs: inputs,
		toParentMessage: (message: PanelMessage) => SessionMessage.GotSpanPanelMessage({ message }),
	})

/**
 * The Details tab: the failure first, a failed tool's captured result (where its error text
 * usually is), the identity rows, then the full attribute maps.
 */
export const detailsSection = (
	h: H,
	model: Model,
	span: AiSessionSpan,
	toolCalls: ReadonlyArray<SpanToolCall>,
	options: Readonly<{ timeZone: string; keyPrefix: string }>,
): Html => {
	const inputs = { span, timeZone: options.timeZone }
	const isFailed = spanFailed(span)
	const failedToolResult =
		isFailed && classifyAiSpan(span) === "tool"
			? toolCalls.find((call) => call.own)?.resultText
			: undefined
	return h.div(
		[h.Class("flex flex-col gap-3 pb-1")],
		[
			...(isFailed ? [panelPart(h, model, "failure", failureView, inputs)] : []),
			...(failedToolResult === undefined
				? []
				: [
						payloadCard(h, model, {
							label: "result",
							name: toolCalls[0]?.name,
							meta: span.statusCode === "Error" ? "span status Error" : undefined,
							body: failedToolResult,
							key: `${options.keyPrefix}:failed-result`,
						}),
					]),
			panelPart(h, model, "identity", identityView, inputs),
			panelPart(h, model, "span-attributes", spanAttributesView, inputs),
			panelPart(h, model, "resource-attributes", resourceAttributesView, inputs),
		],
	)
}

export const logsSection = (h: H, model: Model, span: AiSessionSpan, timeZone: string): Html =>
	panelPart(h, model, "logs", logsView, { span, timeZone })

/** The Tool calls tab: a failed span condemns only the call it executed (`call.own`). */
export const toolCallsSection = (
	h: H,
	model: Model,
	span: AiSessionSpan,
	toolCalls: ReadonlyArray<SpanToolCall>,
	keyPrefix: string,
): Html => {
	if (toolCalls.length === 0) return emptyMessage(h, {}, ["No tool calls were captured on this span."])
	const isFailed = spanFailed(span)
	return h.div(
		[h.Class("flex flex-col gap-3 pb-1")],
		toolCalls.map((call, index) =>
			toolCallCard(h, model, call, {
				isFailed: isFailed && call.own,
				statusCode: span.statusCode,
				keyPrefix: `${keyPrefix}:tool-call-${index}`,
			}),
		),
	)
}
