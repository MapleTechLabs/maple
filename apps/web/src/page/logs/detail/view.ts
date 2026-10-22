import { highlightCode } from "../../../lib/sugar-high"
import * as SheetStyles from "@maple/ui/styles/ui/sheet"
import { cn } from "@maple/ui/lib/utils"
import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as AttributesView from "../../../ui/attributes/attributes-view"
import { copyButton } from "../../../ui/copy-button"
import { titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { icon, type IconName } from "../../../ui/icon"
import type { LogRecord } from "../../../ui/logs/log-row-view"
import { panel, panelBody, panelHeader } from "../../../ui/panel"
import { scrollArea } from "../../../ui/scroll-area"
import * as TabsView from "../../../ui/tabs-view"
import * as InfraCorrelation from "../../kit/infra-correlation"
import { buildLogJsonPayload, TAB_LABELS } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"
import { heroHeader } from "./view-hero"
import { metaStrip } from "./view-meta"
import { contextPanel, errorBanner, showsErrorBanner, traceTimeline } from "./view-panels"

// `LogDetailSheet`: hero, meta strip and the tabbed panels in a right-hand sheet.

type H = HtmlBuilder<Message>

export type ViewInputs = Readonly<{ timeZone: string }>

const TAB_ICONS = new Map<string, IconName>([
	["attributes", "CircleInfoIcon"],
	["trace", "PulseIcon"],
	["context", "UnorderedListIcon"],
	["raw", "SquareTerminalIcon"],
	["infrastructure", "ServerIcon"],
])

/** `LogRawPanel`: the JSON payload, highlighted, with its copy control. */
const rawPanel = (h: H, model: Model, log: LogRecord): Html => {
	const payload = buildLogJsonPayload(log)
	return h.div(
		[],
		[
			h.div(
				[h.Class("flex items-center justify-between mb-2")],
				[
					h.span([h.Class("text-xs font-medium text-muted-foreground")], ["JSON Payload"]),
					copyButton(h, {
						status: copyStatusOf(model, "raw-json"),
						label: "Log JSON",
						idleLabel: "Copy",
						iconSize: 10,
						className: "h-5 px-1.5 text-3xs",
						onClick: Message.ClickedCopy({ copyId: "raw-json", text: payload }),
					}),
				],
			),
			h.pre(
				[
					h.Class(
						"rounded-md border bg-muted/30 p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all",
					),
				],
				[h.code([h.InnerHTML(highlightCode(payload))], [])],
			),
		],
	)
}

const scrolled = (h: H, model: Model, tab: string, child: Html): ReadonlyArray<Html> => [
	scrollArea(h, { className: "h-full", idPrefix: `${model.id}-${tab}-scroll` }, [
		h.div([h.Class("p-3")], [child]),
	]),
]

const panelOf = (h: H, model: Model, log: LogRecord, timeZone: string) => (value: string) => {
	switch (value) {
		case "attributes":
			return scrolled(
				h,
				model,
				value,
				h.submodel({
					slotId: `${model.id}-attributes-panel`,
					model: model.attributes,
					view: AttributesView.view,
					viewInputs: {
						logAttributes: log.logAttributes,
						resourceAttributes: log.resourceAttributes,
						canFilter: true,
					},
					toParentMessage: (message) => Message.GotAttributesMessage({ message }),
				}),
			)
		case "trace":
			return scrolled(h, model, value, traceTimeline(h, model, log) ?? h.div([], []))
		case "context":
			return [contextPanel(h, model, log, timeZone)]
		case "raw":
			return scrolled(h, model, value, rawPanel(h, model, log))
		case "infrastructure":
			return scrolled(
				h,
				model,
				value,
				h.submodel({
					slotId: `${model.id}-infra-panel`,
					model: model.infra,
					view: InfraCorrelation.view,
					viewInputs: {
						resourceAttributes: log.resourceAttributes,
						anchor: log.timestamp,
						spanDurationMs: 0,
						timeZone,
					},
					toParentMessage: (message) => Message.GotInfraMessage({ message }),
				}),
			)
		default:
			return undefined
	}
}

const tabs = (h: H, model: Model, log: LogRecord, timeZone: string): Html =>
	h.submodel({
		slotId: `${model.id}-tabs`,
		model: model.tabs,
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: model.tabs.values.map((value) => TAB_LABELS.get(value) ?? value),
			className: "flex-1 flex flex-col min-h-0",
			listClassName: "shrink-0 px-4",
			panelClassName: "flex-1 min-h-0 mt-0",
			tabContent: (value, label) => [
				icon(h, TAB_ICONS.get(value) ?? "CircleInfoIcon", { size: 14 }),
				` ${label}`,
			],
			panel: panelOf(h, model, log, timeZone),
			hasPanel: () => true,
			panelClassNameFor: (value) => (value === "context" ? "p-3" : undefined),
		},
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
	})

const content = (
	h: H,
	model: Model,
	log: LogRecord,
	timeZone: string,
	close: ReadonlyArray<ChildAttribute>,
) => [
	h.h2(
		[
			h.Class(cn(SheetStyles.sheetTitleStyles, "sr-only")),
			h.DataAttribute("slot", "sheet-title"),
			h.Id(titleId(model.dialog.id)),
		],
		["Log: ", log.body.slice(0, 80)],
	),
	heroHeader(h, model, log, close),
	metaStrip(h, model, log, timeZone),
	...(showsErrorBanner(log) ? [errorBanner(h, model, log)] : []),
	tabs(h, model, log, timeZone),
]

/** The sheet's portal while it is open or closing, else nothing. */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const { log } = model
	if (log === null) return null
	return h.submodel({
		slotId: `${model.id}-sheet`,
		model: model.dialog,
		view: DialogView.view,
		viewInputs: {
			className: "p-0 sm:max-w-2xl",
			side: "right",
			hasTrigger: false,
			showCloseButton: false,
			hasDescription: false,
			toView: ({ portal }) => portal,
			toContent: (close) => content(h, model, log, inputs.timeZone, close),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	})
})

/** `/logs/$logId`'s body: hero and meta as one card, attributes beside trace, context and raw. */
export const pageView = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const { log } = model
	if (log === null) return null
	const trace = traceTimeline(h, model, log)
	return h.div(
		[h.Class("contents")],
		[
			panel(h, { tone: "background" }, [
				heroHeader(h, model, log, null),
				metaStrip(h, model, log, inputs.timeZone, false),
				...(showsErrorBanner(log) ? [errorBanner(h, model, log)] : []),
			]),
			h.div(
				[h.Class("grid gap-3 lg:grid-cols-[1fr_minmax(360px,440px)]")],
				[
					panel(h, {}, [
						panelHeader(h, { title: "Attributes" }),
						panelBody(
							h,
							[
								h.submodel({
									slotId: `${model.id}-attributes-panel`,
									model: model.attributes,
									view: AttributesView.view,
									viewInputs: {
										logAttributes: log.logAttributes,
										resourceAttributes: log.resourceAttributes,
										canFilter: false,
									},
									toParentMessage: (message) => Message.GotAttributesMessage({ message }),
								}),
							],
							"p-3",
						),
					]),
					h.div(
						[h.Class("flex flex-col gap-3")],
						[
							...(trace === null ? [] : [panel(h, { padded: "sm" }, [trace])]),
							panel(h, { padded: "sm" }, [
								contextPanel(h, model, log, inputs.timeZone, "max-h-[420px] flex-none"),
							]),
							panel(h, { padded: "sm" }, [rawPanel(h, model, log)]),
						],
					),
				],
			),
		],
	)
})
