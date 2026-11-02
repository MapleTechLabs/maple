import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as AttributesView from "@maple/views/ui/attributes/attributes-view"
import { copyButton } from "@maple/views/ui/copy-button"
import * as DialogView from "@maple/views/ui/dialog-view"
import { icon, type IconName } from "@maple/views/ui/icon"
import { cappedCode } from "@maple/views/ui/logs/log-message"
import type { LogRecord } from "@maple/views/ui/logs/log-row-view"
import { panel, panelBody, panelHeader } from "@maple/views/ui/panel"
import { scrollArea } from "@maple/views/ui/scroll-area"
import * as TabsView from "@maple/views/ui/tabs-view"
import * as Tooltip from "@maple/views/ui/tooltip"
import { buildLogJsonPayload, TAB_LABELS } from "./derive"
import { Message, type Model } from "./model"
import { copyStatusOf } from "./update"
import { heroHeader } from "./view-hero"
import { type MetaInputs, metaStrip, type TooltipParts, tooltipContent, triggerIdsOf } from "./view-meta"
import { contextPanel, errorBanner, showsErrorBanner, traceTimeline } from "./view-panels"
import { typography } from "@maple/views/ui/typography"
import { vstack, vstackClass } from "@maple/views/ui/stack"

// `LogDetailSheet`: hero, meta strip and the tabbed panels in a right-hand sheet.

type H = HtmlBuilder<Message>

export type ViewInputs = MetaInputs & Readonly<{
	/** The attributes' Filter actions (`ChoseAttributeFilter`), where the app can filter by them. */
	canFilter: boolean
	/** The Infrastructure tab's body, built by the app that can back it (`open`'s `hasInfra`). */
	infraTab?: (() => Html) | undefined
}>

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
					typography(h, { size: "xs", tone: "muted", weight: "medium" }, ["JSON Payload"]),
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
			...cappedCode(
				h,
				payload,
				"rounded-md border bg-surface-sunken p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap break-all",
			),
		],
	)
}

const scrolled = (h: H, model: Model, tab: string, child: Html): ReadonlyArray<Html> => [
	scrollArea(h, { className: "h-full", idPrefix: `${model.id}-${tab}-scroll` }, [
		h.div([h.Class("p-3")], [child]),
	]),
]

const panelOf = (h: H, model: Model, log: LogRecord, inputs: ViewInputs) => (value: string) => {
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
						canFilter: inputs.canFilter,
					},
					toParentMessage: (message) => Message.GotAttributesMessage({ message }),
				}),
			)
		case "trace":
			return scrolled(h, model, value, traceTimeline(h, model, log) ?? h.div([], []))
		case "context":
			return [contextPanel(h, model, log, inputs.timeZone)]
		case "raw":
			return scrolled(h, model, value, rawPanel(h, model, log))
		case "infrastructure":
			return inputs.infraTab === undefined ? undefined : scrolled(h, model, value, inputs.infraTab())
		default:
			return undefined
	}
}

const tabs = (h: H, model: Model, log: LogRecord, inputs: ViewInputs): Html =>
	h.submodel({
		slotId: `${model.id}-tabs`,
		model: model.tabs,
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: model.tabs.values.map((value) => TAB_LABELS.get(value) ?? value),
			className: vstackClass({ grow: true, className: "min-h-0" }),
			listClassName: "shrink-0 px-4",
			panelClassName: "flex-1 min-h-0 mt-0",
			tabContent: (value, label) => [
				icon(h, TAB_ICONS.get(value) ?? "CircleInfoIcon", { size: 14 }),
				` ${label}`,
			],
			panel: panelOf(h, model, log, inputs),
			hasPanel: () => true,
			panelClassNameFor: (value) => (value === "context" ? "p-3" : undefined),
		},
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
	})

/** The copy controls' one Tooltip around `render`; each trigger keeps its portal beside it. */
const withTooltip = (h: H, model: Model, render: (tooltip: TooltipParts) => ReadonlyArray<Html | null>): Html =>
	h.submodel({
		slotId: `${model.tooltip.id}-slot`,
		model: model.tooltip,
		view: Tooltip.view,
		viewInputs: {
			triggerIds: triggerIdsOf(model),
			toContent: (triggerId) => tooltipContent(model, triggerId),
			toView: ({ trigger, portal }) =>
				h.div(
					[h.Class("contents")],
					render({
						trigger,
						portalFor: (id) => (portal !== null && model.tooltip.triggerId === id ? [portal] : []),
					}),
				),
		},
		toParentMessage: (message) => Message.GotTooltipMessage({ message }),
	})

const content = (
	h: H,
	model: Model,
	log: LogRecord,
	inputs: ViewInputs,
	close: ReadonlyArray<ChildAttribute>,
) => [
	DialogView.dialogTitle(h, "sheet", model.dialog.id, ["Log: ", log.body.slice(0, 80)], "sr-only"),
	withTooltip(h, model, (tooltip) => [
		heroHeader(h, model, log, close),
		metaStrip(h, model, log, inputs, tooltip),
		...(showsErrorBanner(log) ? [errorBanner(h, model, log, tooltip)] : []),
		tabs(h, model, log, inputs),
	]),
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
			toContent: (close) => content(h, model, log, inputs, close),
		},
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
	})
})

/** `/logs/$logId`'s body: hero and meta as one card, attributes beside trace, context and raw. */
export const pageView = Submodel.defineView<Model, Message, MetaInputs>((model, inputs, h) => {
	const { log } = model
	if (log === null) return null
	const trace = traceTimeline(h, model, log)
	return h.div(
		[h.Class("contents")],
		[
			panel(h, { tone: "background" }, [
				withTooltip(h, model, (tooltip) => [
					heroHeader(h, model, log, null),
					metaStrip(h, model, log, inputs, tooltip, false),
					...(showsErrorBanner(log) ? [errorBanner(h, model, log, tooltip)] : []),
				]),
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
					vstack(h, { gap: "3" }, [
						...(trace === null ? [] : [panel(h, { padded: "sm" }, [trace])]),
						panel(h, { padded: "sm" }, [
							contextPanel(h, model, log, inputs.timeZone, "max-h-[420px] flex-none"),
						]),
						panel(h, { padded: "sm" }, [rawPanel(h, model, log)]),
					]),
				],
			),
		],
	)
})
