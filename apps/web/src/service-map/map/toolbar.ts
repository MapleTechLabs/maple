import { Option, Schema } from "effect"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as Combobox from "../../ui/combobox"
import * as ComboboxView from "../../ui/combobox-view"
import { separator } from "../../ui/display"
import { icon } from "../../ui/icon"
import { iconButton } from "../../ui/icon-button"
import * as Select from "../../ui/select"
import * as SelectView from "../../ui/select-view"
import { toggle } from "../../ui/toggle"
import * as Tooltip from "../../ui/tooltip"
import { serviceDot } from "../../ui/values"
import type { ColorMode, Focus } from "./state"

// `ServiceMapToolbar` (packages/ui `service-map/service-map-toolbar.tsx`): focus a service (or the
// focus chip, depth and "Hide rest"), the traffic threshold, colour mode and Re-sort.

/** `TRAFFIC_FILTER_STEPS`: discrete thresholds (% of the peak edge rate); 0 shows everything. */
export const TRAFFIC_FILTER_STEPS = [0, 0.1, 1, 5] as const

const trafficStepLabel = (pct: number): string => (pct === 0 ? "All traffic" : `> ${pct}% of peak`)

export const FOCUS_COMBOBOX_ID = "service-map-focus"
const TIP_RESORT = "service-map-tip-resort"
const TIP_HIDE_REST = "service-map-tip-hide-rest"
const TIP_HIDDEN = "service-map-tip-hidden"

export const Model = Schema.Struct({
	focusCombobox: Combobox.Model,
	trafficSelect: Select.Model,
	colorSelect: Select.Model,
	depthSelect: Select.Model,
	tooltip: Tooltip.Model,
})
export type Model = typeof Model.Type

export const init = (): Model => ({
	focusCombobox: Combobox.init(FOCUS_COMBOBOX_ID, "single"),
	trafficSelect: Select.init("service-map-traffic", { value: "0", selectedIndex: 0 }),
	colorSelect: Select.init("service-map-color", { value: "service", selectedIndex: 0 }),
	depthSelect: Select.init("service-map-depth", { value: "1", selectedIndex: 0 }),
	tooltip: Tooltip.init("service-map-toolbar-tip", { side: "bottom" }),
})

export type ToolbarInputs<M> = Readonly<{
	model: Model
	focus: Option.Option<Focus>
	services: ReadonlyArray<string>
	minTrafficPct: number
	colorMode: ColorMode
	hiddenNodeCount: number
	hiddenEdgeCount: number
	showPresentationControls: boolean
	toCombobox: (message: Combobox.Message) => M
	toTraffic: (message: Select.Message) => M
	toColor: (message: Select.Message) => M
	toDepth: (message: Select.Message) => M
	toTooltip: (message: Tooltip.Message) => M
	onClearFocus: M
	onToggleHideRest: M
	onShowAllTraffic: M
	onResort: M
}>

type Trigger = (id?: string) => ReadonlyArray<ChildAttribute>

/** Select parts land in the bar itself: the trigger and its hidden input are flex siblings. */
const contents = <M>(h: HtmlBuilder<M>, parts: ReadonlyArray<Html>): Html =>
	h.div([h.Class("contents")], parts)

const focusCombobox = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>): Html =>
	h.submodel({
		slotId: FOCUS_COMBOBOX_ID,
		model: inputs.model.focusCombobox,
		view: ComboboxView.view,
		toParentMessage: inputs.toCombobox,
		viewInputs: {
			items: inputs.services,
			placeholder: "Focus a service…",
			emptyText: "No services found.",
			size: "sm",
			showTrigger: false,
			isUnfiltered: true,
			anchorsInput: true,
			className: "w-full",
			startAddon: icon(h, "MagnifierIcon", {
				size: 14,
				attributes: [h.Attribute("stroke-width", "2")],
			}),
			renderItem: (service) => [
				serviceDot(h, { serviceName: service, className: "size-1.5" }),
				service,
			],
			// The wrapper carries the responsive width, not the input.
			toView: ({ field, rest }) => h.div([h.Class("w-full sm:w-52")], [field, ...rest]),
		},
	})

const DEPTH_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = [
	{ _tag: "Item", item: { value: "1", label: "1 hop" } },
	{ _tag: "Item", item: { value: "2", label: "2 hops" } },
]

const focusControls = <M>(
	h: HtmlBuilder<M>,
	inputs: ToolbarInputs<M>,
	focus: Focus,
	trigger: Trigger,
): ReadonlyArray<Html> => [
	h.span(
		[
			h.Class(
				"flex h-7 items-center gap-1.5 rounded-lg border border-input bg-background pr-1 pl-2 text-sm dark:bg-input/32",
			),
		],
		[
			serviceDot(h, { serviceName: focus.serviceId, className: "size-1.5 shrink-0" }),
			h.span([h.Class("max-w-40 truncate font-medium")], [focus.serviceId]),
			iconButton(
				h,
				{
					size: "icon-xs",
					label: "Clear focus",
					className: "-mr-0.5 size-5 text-muted-foreground hover:text-foreground sm:size-5",
					attributes: [h.OnClick(inputs.onClearFocus)],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	),
	h.submodel({
		slotId: "service-map-depth",
		model: { ...inputs.model.depthSelect, value: String(focus.hops) },
		view: SelectView.view,
		toParentMessage: inputs.toDepth,
		viewInputs: {
			entries: DEPTH_ENTRIES,
			size: "sm",
			className: "min-w-0",
			ariaLabel: "Focus depth",
			toView: (parts) => contents(h, parts),
		},
	}),
	toggle(
		h,
		{
			variant: "outline",
			size: "sm",
			className: "px-2.5",
			isPressed: focus.mode === "hide",
			onClick: inputs.onToggleHideRest,
			attributes: trigger(TIP_HIDE_REST),
		},
		["Hide rest"],
	),
]

const TRAFFIC_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = TRAFFIC_FILTER_STEPS.map((pct) => ({
	_tag: "Item",
	item: { value: String(pct), label: trafficStepLabel(pct) },
}))

const COLOR_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = [
	{ _tag: "Item", item: { value: "service", label: "Service" } },
	{ _tag: "Item", item: { value: "health", label: "Health" } },
	{ _tag: "Item", item: { value: "platform", label: "Platform" } },
]

const tipContent = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>, triggerId: string): Html =>
	h.p(
		[],
		triggerId === TIP_RESORT
			? ["Discard manual positions and auto-arrange"]
			: triggerId === TIP_HIDE_REST
				? ["Remove everything outside the neighborhood and re-layout, instead of fading it"]
				: ["Below ", String(inputs.minTrafficPct), "% of the peak edge rate. Click to show all"],
	)

const hiddenButton = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>, trigger: Trigger): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "sm",
			className: "text-muted-foreground",
			attributes: [...trigger(TIP_HIDDEN), h.OnClick(inputs.onShowAllTraffic)],
		},
		[
			...(inputs.hiddenNodeCount > 0 ? [`${inputs.hiddenNodeCount} services · `] : []),
			String(inputs.hiddenEdgeCount),
			" edges hidden",
		],
	)

const presentationControls = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>, trigger: Trigger): Html =>
	h.submodel({
		slotId: "service-map-color",
		model: { ...inputs.model.colorSelect, value: inputs.colorMode },
		view: SelectView.view,
		toParentMessage: inputs.toColor,
		viewInputs: {
			entries: COLOR_ENTRIES,
			size: "sm",
			className: "min-w-0 capitalize",
			ariaLabel: "Color nodes by",
			leading: [icon(h, "PaletteIcon", { size: 14, className: "text-muted-foreground" })],
			// The value shows raw, capitalized by CSS.
			renderValue: (value) => [value],
			toView: (parts) =>
				h.div(
					[h.Class("ml-auto flex items-center gap-2")],
					[
						...parts,
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "max-sm:size-8 max-sm:px-0",
								attributes: [
									...trigger(TIP_RESORT),
									h.AriaLabel("Re-sort"),
									h.OnClick(inputs.onResort),
								],
							},
							[
								icon(h, "ArrowRotateAnticlockwiseIcon"),
								h.span([h.Class("max-sm:sr-only")], ["Re-sort"]),
							],
						),
					],
				),
		},
	})

const bar = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>, trigger: Trigger, portal: Html | null): Html =>
	h.div(
		[h.Class("flex shrink-0 flex-wrap items-center gap-2 border-b bg-muted/30 px-3 py-2")],
		[
			...Option.match(inputs.focus, {
				onNone: () => [focusCombobox(h, inputs)],
				onSome: (focus) => focusControls(h, inputs, focus, trigger),
			}),
			separator(h, "vertical", "hidden h-5 sm:block"),
			h.submodel({
				slotId: "service-map-traffic",
				model: { ...inputs.model.trafficSelect, value: String(inputs.minTrafficPct) },
				view: SelectView.view,
				toParentMessage: inputs.toTraffic,
				viewInputs: {
					entries: TRAFFIC_ENTRIES,
					size: "sm",
					className: "min-w-0",
					ariaLabel: "Traffic threshold",
					toView: (parts) => contents(h, parts),
				},
			}),
			...(inputs.hiddenNodeCount > 0 || inputs.hiddenEdgeCount > 0
				? [hiddenButton(h, inputs, trigger)]
				: []),
			...(inputs.showPresentationControls ? [presentationControls(h, inputs, trigger)] : []),
			...(portal === null ? [] : [portal]),
		],
	)

/** The bar, its three tooltips sharing one Tooltip. */
export const serviceMapToolbar = <M>(h: HtmlBuilder<M>, inputs: ToolbarInputs<M>): Html =>
	h.submodel({
		slotId: "service-map-toolbar-tip",
		model: inputs.model.tooltip,
		view: Tooltip.view,
		toParentMessage: inputs.toTooltip,
		viewInputs: {
			triggerIds: [TIP_RESORT, TIP_HIDE_REST, TIP_HIDDEN],
			toContent: (triggerId) => [tipContent(h, inputs, triggerId)],
			toView: ({ trigger, portal }) => bar(h, inputs, trigger, portal),
		},
	})
