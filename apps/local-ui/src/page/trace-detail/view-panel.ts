import * as Keyed from "@maple/web/data/keyed"
import * as InfraCorrelation from "@maple/web/page/kit/infra-correlation/update"
import type { TimeFormat } from "../kit/local-time"
import type * as SpanPanelMessage from "@maple/web/page/traces/detail/span-panel/message"
import type * as SpanPanel from "@maple/web/page/traces/detail/span-panel/model"
import { getServiceColor } from "@maple/ui/lib/colors"
import { badge } from "@maple/web/ui/display"
import { icon } from "@maple/web/ui/icon"
import { scrollArea } from "@maple/web/ui/scroll-area"
import * as TabsView from "@maple/web/ui/tabs-view"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureWithoutData, isPending } from "../../data/slot"
import { FocusSpanPanel } from "./command"
import { Message } from "./message"
import { LOG_LIMIT, type PanelModel } from "./panel-model"
import { attributesFailedNote, attributesPending, sectionView } from "./view-attributes"
import { spanLogs } from "./view-panel-logs"
import { detailsView, headerView, summaryView } from "./view-panel-parts"

// The span detail panel beside the waterfall.

type H = HtmlBuilder<Message>

/** The web panel Model its header, copy and error parts read; they only use span, copies and disclosure. */
const partsModel = (panel: PanelModel, traceStartTime: string, totalDurationMs: number): SpanPanel.Model => ({
	span: panel.span,
	traceStartTime,
	totalDurationMs,
	detail: Keyed.idle(),
	logs: Keyed.idle(),
	tabs: panel.tabs,
	copies: panel.copies,
	openIds: [],
	isErrorExpanded: panel.isErrorExpanded,
	// The local panel has no Infrastructure tab.
	infra: InfraCorrelation.init(`local-span-${panel.span.spanId}-infra`, ""),
})

const toParts = (message: SpanPanelMessage.Message) => Message.GotSpanPanelMessage({ message })

/** `logCount`: the query stops at the limit, so a full page reads "100+". */
const logCountLabel = (panel: PanelModel): string | null =>
	Option.match(AsyncData.getData(panel.logs.data), {
		onNone: () => null,
		onSome: (logs) =>
			logs.length === 0 ? null : logs.length >= LOG_LIMIT ? `${LOG_LIMIT}+` : String(logs.length),
	})

/** The full maps once loaded, else the trimmed ones the tree carried. */
const attributeBlocks = (h: H, panel: PanelModel): ReadonlyArray<Html> => {
	const { span } = panel
	const section = (attributes: Readonly<Record<string, string>>, title: string, id: string) =>
		h.submodel({
			slotId: `span-attributes:${id}`,
			model: panel.attributes,
			view: sectionView,
			viewInputs: { attributes, title, section: id },
			toParentMessage: (message) => Message.GotAttributesMessage({ message }),
		})
	if (span.isMissing === true) return [section(span.spanAttributes, "Span attributes", "span")]
	if (isPending(panel.detail)) return [attributesPending(h)]
	const detail = Option.flatMap(AsyncData.getData(panel.detail.data), Option.fromNullishOr)
	return [
		...(Option.isSome(failureWithoutData(panel.detail)) ? [attributesFailedNote(h)] : []),
		section(
			Option.match(detail, { onNone: () => span.spanAttributes, onSome: (d) => d.spanAttributes }),
			"Span attributes",
			"span",
		),
		section(
			Option.match(detail, {
				onNone: () => span.resourceAttributes,
				onSome: (d) => d.resourceAttributes,
			}),
			"Resource attributes",
			"resource",
		),
	]
}

const TAB_ICONS = new Map([
	["details", "CircleInfoIcon"],
	["logs", "FileIcon"],
] as const)

export type PanelViewInput = Readonly<{
	traceStartTime: string
	totalDurationMs: number
	nowMs: number
	timeFormat: TimeFormat
}>

/** The span's identity header, then everything under it scrolling as one (summary, error, tabs). */
export const spanPanel = (h: H, panel: PanelModel, input: PanelViewInput): Html => {
	const parts = partsModel(panel, input.traceStartTime, input.totalDurationMs)
	const color = getServiceColor(panel.span.serviceName)
	const detail = Option.flatMap(AsyncData.getData(panel.detail.data), Option.fromNullishOr)
	const logCount = logCountLabel(panel)
	return h.aside(
		[
			h.Tabindex(-1),
			h.OnMount(FocusSpanPanel()),
			h.Class(
				"flex h-full w-full shrink-0 flex-col overflow-hidden border-l bg-background focus:outline-none sm:w-[28rem]",
			),
		],
		[
			h.submodel({
				slotId: "span-panel-header",
				model: parts,
				view: headerView,
				toParentMessage: toParts,
			}),
			scrollArea(h, { className: "min-h-0 flex-1", idPrefix: "span-panel-scroll" }, [
				h.submodel({
					slotId: "span-panel-summary",
					model: parts,
					view: summaryView,
					viewInputs: {
						attributes: Option.match(detail, {
							onNone: () => panel.span.spanAttributes,
							onSome: (d) => d.spanAttributes,
						}),
					},
					toParentMessage: toParts,
				}),
				h.submodel({
					slotId: "span-panel-tabs",
					model: panel.tabs,
					view: TabsView.view,
					viewInputs: {
						variant: "underline",
						labels: ["Details", "Logs"],
						listClassName:
							"sticky top-0 z-10 w-full justify-start bg-background px-4 *:data-[slot=tabs-tab]:grow-0",
						panelClassName: "mt-0",
						tabContent: (value: string, label: string) => [
							icon(
								h,
								TAB_ICONS.get(value === "logs" ? "logs" : "details") ?? "CircleInfoIcon",
								{ size: 14 },
							),
							` ${label}`,
							...(value === "logs" && logCount !== null
								? [
										badge(h, { variant: "secondary", size: "xs", className: "ml-1" }, [
											logCount,
										]),
									]
								: []),
						],
						panel: (value: string) =>
							value === "logs"
								? spanLogs(h, panel, input.nowMs, input.timeFormat)
								: [
										h.submodel({
											slotId: "span-panel-details",
											model: parts,
											view: detailsView,
											viewInputs: {
												color,
												attributes: () => attributeBlocks(h, panel),
												timeFormat: input.timeFormat,
											},
											toParentMessage: toParts,
										}),
									],
					},
					toParentMessage: (message) => Message.GotPanelTabsMessage({ message }),
				}),
			]),
		],
	)
}
