import { warehouseDateTimeToIso } from "@maple/query-engine"
import { getServiceColor } from "@maple/ui/lib/colors"
import { formatDuration } from "@maple/ui/lib/format"
import { getActiveInfraCorrelations } from "../../../../components/infra/infra-correlations"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { keyValue, keyValueList } from "../../../../ui/key-value"
import { scrollArea } from "../../../../ui/scroll-area"
import { skeleton } from "../../../../ui/skeleton"
import * as InfraCorrelation from "../../../kit/infra-correlation"
import { attributesSection } from "./attributes"
import { copyableValue, selectableValue } from "./copy"
import { errorSection } from "./error-section"
import { spanEventsSection } from "./events"
import { Message } from "./message"
import type { Model } from "./model"
import { getCloudPlatform } from "./platform"
import { cacheSummary, formatTimestamp, panelHeader, platformSummary, summaryStats } from "./view-header"
import { spanLogs, tabsView } from "./view-tabs"

export type ViewInputs = Readonly<{ timeZone: string }>

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
			h.h4([h.Class("text-xs font-medium text-muted-foreground")], ["Span"]),
			h.div(
				[h.Class("rounded-md border p-2 space-y-1 text-xs")],
				[
					span.isMissing === true ? null : positionBar(h, model, color),
					keyValueList(h, { className: "gap-1" }, [
						keyValue(h, { label: "Start time", mono: true }, [
							copyableValue(h, model, { id: "start-time", value: span.startTime }, [
								formatTimestamp(span.startTime, timeZone, true),
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
												h.button(
													[
														h.Class(
															"font-mono underline decoration-dotted underline-offset-2 hover:text-primary",
														),
														h.Title("Select the parent span"),
														h.Type("button"),
														h.OnClick(
															Message.ClickedParentSpan({
																spanId: span.parentSpanId,
															}),
														),
													],
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
const attributesBody = (h: H, model: Model): ReadonlyArray<Html | null> => {
	const { span } = model
	if (span.isMissing === true)
		return [attributesSection(h, model, "span", span.spanAttributes, "Span attributes")]
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
			attributesSection(h, model, "span", span.spanAttributes, "Span attributes"),
			attributesSection(h, model, "resource", span.resourceAttributes, "Resource attributes"),
		],
		onData: (detail) => [
			spanEventsSection(h, model, detail.events),
			attributesSection(h, model, "span", detail.spanAttributes, "Span attributes"),
			attributesSection(h, model, "resource", detail.resourceAttributes, "Resource attributes"),
		],
	})
}

/** The root `<SpanDetailPanel />` as the page's ResizablePanel holds it. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const { span } = model
	const detail = AsyncData.getData(model.detail.data)
	const serviceColor = getServiceColor(span.serviceName)
	const infraAttrs = Option.match(detail, {
		onNone: () => span.resourceAttributes,
		onSome: (loaded) => loaded.resourceAttributes,
	})
	const spanAttrs = Option.match(detail, {
		onNone: () => span.spanAttributes,
		onSome: (loaded) => loaded.spanAttributes,
	})
	const hasInfra = getActiveInfraCorrelations({ ...infraAttrs }).length > 0
	const platform = getCloudPlatform(spanAttrs)
	const values = hasInfra
		? (["details", "logs", "infrastructure"] as const)
		: (["details", "logs"] as const)
	return h.div(
		[h.Class("flex flex-col h-full bg-background overflow-hidden")],
		[
			panelHeader(h, model),
			scrollArea(h, { className: "min-h-0 flex-1", idPrefix: "span-panel-scroll" }, [
				summaryStats(h, model),
				...[cacheSummary(h, model)].filter((node) => node !== null),
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
										...attributesBody(h, model),
									],
								),
							]
						: value === "logs"
							? [spanLogs(h, model, inputs.timeZone)]
							: [
									h.div(
										[h.Class("p-3")],
										[
											h.submodel({
												slotId: `${model.infra.id}-panel`,
												model: model.infra,
												view: InfraCorrelation.view,
												viewInputs: {
													resourceAttributes: infraAttrs,
													anchor: span.startTime,
													spanDurationMs: span.durationMs,
													timeZone: inputs.timeZone,
												},
												toParentMessage: (message) =>
													Message.GotInfraMessage({ message }),
											}),
										],
									),
								],
				),
			]),
		],
	)
})
