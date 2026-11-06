import { warehouseDateTimeToIso } from "@maple/query-engine"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/lib/format"
import { Option, Array as Arr } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "@maple/views/ui/heading"
import { keyValue, keyValueList } from "@maple/views/ui/key-value"
import { scrollArea } from "@maple/views/ui/scroll-area"
import { skeleton } from "@maple/views/ui/skeleton"
import { textLink } from "@maple/views/ui/text-link"
import { timestamp } from "@maple/views/ui/timestamp"
import { attributesSection } from "./attributes"
import { copyableValue, selectableValue } from "./copy"
import { errorSection } from "./error-section"
import { spanEventsSection } from "./events"
import { Message } from "./message"
import type { Model } from "./model"
import type { SpanDetail } from "../trace-source"
import { getCloudPlatform } from "./platform"
import { cacheSummary, panelHeader, platformSummary, summaryStats } from "./view-header"
import { spanLogs, tabsView } from "./view-tabs"
import { sidePanelFrame } from "../../ui/side-panel"

export type ViewInputs = Readonly<{
	timeZone: string
	/** Attribute rows offer Filter / Exclude (`RequestedAttributeFilter`). */
	canFilterAttributes: boolean
	/** The Logs tab's empty state links here. */
	logsDocsHref?: string
	/** The Infrastructure tab's body, built by the app that can back it; no tab without it. */
	infraTab?: (() => Html) | undefined
}>

type H = HtmlBuilder<Message>

const epochOf = (value: string): number => new Date(warehouseDateTimeToIso(value)).getTime()

/** `SpanPositionBar`: the span's window inside the trace's wall-clock track. */
const positionBar = (h: H, model: Model, color: string): Html | null => {
	const offsetMs = epochOf(model.span.startTime) - epochOf(model.traceStartTime)
	const total = model.totalDurationMs
	if (!Number.isFinite(offsetMs) || total <= 0) return null
	const offsetPct = Math.min(Math.max((offsetMs / total) * 100, 0), 100)
	const widthPct = Math.min(Math.max((model.span.durationMs / total) * 100, 0.75), 100 - offsetPct)
	return h.div(
		[h.Class("py-1")],
		[
			h.div(
				[h.Class("relative h-1.5 w-full overflow-hidden rounded-full bg-muted")],
				[
					h.div(
						[
							h.Class("absolute inset-y-0 rounded-full"),
							h.Style({
								left: `${offsetPct}%`,
								width: `${widthPct}%`,
								"background-color": color,
							}),
						],
						[],
					),
				],
			),
			h.div(
				[h.Class("mt-1 flex justify-between text-3xs text-muted-foreground tabular-nums")],
				[
					offsetMs < 0
						? h.span(
								[
									h.Class("text-severity-warn"),
									h.Title("Starts before the trace root: the clocks disagree"),
								],
								["−", formatDuration(Math.abs(offsetMs)), " (clock skew)"],
							)
						: h.span([], ["+", formatDuration(offsetMs)]),
					h.span([], [formatDuration(total), " total"]),
				],
			),
		],
	)
}

const spanCard = (h: H, model: Model, timeZone: string, color: string): Html => {
	const { span } = model
	return h.div(
		[h.Class("space-y-1")],
		[
			heading(h, { level: 4, variant: "label" }, ["Span"]),
			h.div(
				[h.Class("rounded-md border p-2 space-y-1 text-xs")],
				[
					span.isMissing === true ? null : positionBar(h, model, color),
					keyValueList(h, { className: "gap-1" }, [
						keyValue(h, { label: "Start time", mono: true }, [
							copyableValue(h, model, { id: "start-time", value: span.startTime }, [
								timestamp(h, {
									value: span.startTime,
									timeZone,
									withMilliseconds: true,
									className: "cursor-pointer",
								}),
							]),
						]),
						keyValue(h, { label: "Span ID", mono: true }, [
							copyableValue(h, model, { id: "span-id", value: span.spanId }, [span.spanId]),
						]),
						...(span.parentSpanId === ""
							? []
							: [
									keyValue(h, { label: "Parent span ID", mono: true }, [
										selectableValue(
											h,
											model,
											{
												id: "parent-span-id",
												value: span.parentSpanId,
												label: "parent span ID",
											},
											[
												textLink(
													h,
													{
														tone: "muted",
														isMono: true,
														onClick: Message.ClickedParentSpan({
															spanId: span.parentSpanId,
														}),
														className:
															"text-foreground underline decoration-dotted hover:text-primary active:text-primary",
														attributes: [h.Title("Select the parent span")],
													},
													[span.parentSpanId],
												),
											],
										),
									]),
								]),
					]),
				],
			),
		],
	)
}

/** The span and resource attributes: full maps once loaded, the trimmed ones if that fails. */
const attributesBody = (h: H, model: Model, isFilterable: boolean): ReadonlyArray<Html | null> => {
	const { span } = model
	const section = (
		scope: "span" | "resource",
		attributes: Readonly<Record<string, string>>,
		title: string,
	) => attributesSection(h, model, scope, attributes, title, { isFilterable })
	if (span.isMissing === true) return [section("span", span.spanAttributes, "Span attributes")]
	return AsyncData.matchData(model.detail.data, {
		onEmpty: (): ReadonlyArray<Html | null> => [
			h.div(
				[h.Class("space-y-2")],
				[
					skeleton(h, "h-4 w-32"),
					skeleton(h, "h-24 w-full"),
					skeleton(h, "h-4 w-32"),
					skeleton(h, "h-24 w-full"),
				],
			),
		],
		onFailure: () => [
			h.p(
				[h.Class("rounded-md border border-dashed px-2 py-1.5 text-2xs text-muted-foreground")],
				["Couldn't load all attributes. Showing the ones loaded with the trace."],
			),
			section("span", span.spanAttributes, "Span attributes"),
			section("resource", span.resourceAttributes, "Resource attributes"),
		],
		onData: (detail) => [
			spanEventsSection(h, model, detail.events),
			section("span", detail.spanAttributes, "Span attributes"),
			section("resource", detail.resourceAttributes, "Resource attributes"),
		],
	})
}

const loadedOr = (
	model: Model,
	pick: (detail: SpanDetail) => Readonly<Record<string, string>>,
	fallback: Readonly<Record<string, string>>,
) => Option.match(AsyncData.getData(model.detail.data), { onNone: () => fallback, onSome: pick })

/** The span's resource attributes: the full map once loaded, else the trimmed one. */
export const resourceAttributesOf = (model: Model): Readonly<Record<string, string>> =>
	loadedOr(model, (detail) => detail.resourceAttributes, model.span.resourceAttributes)

/** The root `<SpanDetailPanel />` as the page's ResizablePanel holds it. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const { span } = model
	const serviceColor = getServiceColor(span.serviceName)
	const spanAttrs = loadedOr(model, (detail) => detail.spanAttributes, span.spanAttributes)
	const platform = getCloudPlatform(spanAttrs)
	const { infraTab } = inputs
	const values =
		infraTab === undefined
			? (["details", "logs"] as const)
			: (["details", "logs", "infrastructure"] as const)
	return sidePanelFrame(h, [
		panelHeader(h, model),
		scrollArea(h, { className: "min-h-0 flex-1", idPrefix: "span-panel-scroll" }, [
			summaryStats(h, model),
			...Arr.filter([cacheSummary(h, model)], (node) => node !== null),
			...(platform === null ? [] : [platformSummary(h, model, platform)]),
			...(span.statusCode === "Error" && span.statusMessage !== ""
				? [
						errorSection(h, model, {
							message: span.statusMessage,
							prompt: {
								serviceName: span.serviceName,
								operation: span.spanName,
								attributes: spanAttrs,
							},
						}),
					]
				: []),
			tabsView(h, model, values, (value) =>
				value === "details"
					? [
							h.div(
								[h.Class("p-3 space-y-3")],
								[
									spanCard(h, model, inputs.timeZone, serviceColor),
									...attributesBody(h, model, inputs.canFilterAttributes),
								],
							),
						]
					: value === "logs" || infraTab === undefined
						? [spanLogs(h, model, inputs.timeZone, inputs.logsDocsHref)]
						: [h.div([h.Class("p-3")], [infraTab()])],
			),
		]),
	])
})
