import { cn } from "@maple/ui/lib/utils"
import {
	tabsIndicatorDefaultStyles,
	tabsIndicatorStyles,
	tabsIndicatorUnderlineStyles,
	tabsListDefaultStyles,
	tabsListStyles,
	tabsListUnderlineStyles,
	tabsListVerticalStyles,
	tabsPanelStyles,
	tabsStyles,
	tabsTabStyles,
} from "@maple/ui/styles/ui/tabs"
import { Option, Schema } from "effect"
import { Block } from "foldkit"
import type { Html } from "foldkit/html"
import {
	EffectsLayer,
	type IndicatorRect,
	init,
	MeasureTabIndicator,
	Message,
	Model,
	panelId,
	TabKey,
	TabsComposition,
	type TabsViewBuilder,
	tabId,
	update,
} from "./tabs"

// Base UI's Tabs DOM: the same data attributes, roles, roving tabindex and `useId` ids.

export type TabsVariant = "default" | "underline"

export interface TabsViewInputs {
	readonly variant?: TabsVariant
	/** One label per `model.values` entry. */
	readonly labels: ReadonlyArray<string>
	/** A tab's children when it has more than its label (an icon before it). */
	readonly tabContent?: (value: string, label: string) => ReadonlyArray<Html | string>
	readonly className?: string
	/** `<TabsList className>`. */
	readonly listClassName?: string
	readonly panelClassName?: string
	/** Extra panel classes for one value (`<TabsContent className>` differing per tab). */
	readonly panelClassNameFor?: (value: string) => string | undefined
	/** The list inside a wrapper (`<div className="border-b"><TabsList /></div>`). */
	readonly wrapList?: (list: Html) => Html
	/** `<TabsTab className>` for every tab. */
	readonly tabClassName?: string
	/** `<TabsList aria-label>`. */
	readonly ariaLabel?: string
	/** Panel content for a value; values without one render no panel (Base UI unmounts it). */
	readonly panel: (value: string) => ReadonlyArray<Html | string> | undefined
	/** Which values have a panel, without building them (a panel holding a child Block renders once). */
	readonly hasPanel?: (value: string) => boolean
	/** The rendered subset of `model.values`, in order; ids still follow each value's model index. */
	readonly values?: ReadonlyArray<string>
	/** The panel shown while the selected value is not among `values`. */
	readonly fallbackValue?: string
}

type H = TabsViewBuilder

const stateAttributes = (h: H, model: Model) => [
	h.DataAttribute("activation-direction", model.activationDirection),
	h.DataAttribute("orientation", "horizontal"),
]

const indicatorStyle = (rect: IndicatorRect): string =>
	[
		`--active-tab-left: ${rect.left}px;`,
		`--active-tab-right: ${rect.right}px;`,
		`--active-tab-top: ${rect.top}px;`,
		`--active-tab-bottom: ${rect.bottom}px;`,
		`--active-tab-width: ${rect.width}px;`,
		`--active-tab-height: ${rect.height}px;`,
	].join(" ")

const isTabKey = Schema.is(TabKey)

const toTabKey = (key: string): Option.Option<Message> =>
	isTabKey(key) ? Option.some(Message.PressedTabKey({ key })) : Option.none()

const tab = (
	h: H,
	model: Model,
	index: number,
	label: string,
	hasPanel: boolean,
	className: string | undefined,
	content: TabsViewInputs["tabContent"],
): Html => {
	const value = model.values[index]
	const isActive = value === model.selected
	const isHighlighted = index === model.highlightedIndex
	return h.button(
		[
			...(isActive && hasPanel ? [h.AriaControls(panelId(model))] : []),
			h.AriaDisabled(false),
			h.AriaSelected(isActive),
			h.Attribute("class", cn(tabsTabStyles, className)),
			...stateAttributes(h, model),
			...(isActive ? [h.DataAttribute("active", "")] : []),
			...(isHighlighted ? [h.DataAttribute("composite-item-active", "")] : []),
			h.DataAttribute("slot", "tabs-tab"),
			h.Id(tabId(model, index)),
			h.Role("tab"),
			h.Attribute("tabindex", isHighlighted ? "0" : "-1"),
			h.Type("button"),
			h.OnClick(Message.ClickedTab({ index })),
			h.OnKeyDownPreventDefault(toTabKey),
		],
		content === undefined || value === undefined ? [label] : content(value, label),
	)
}

const indicator = (h: H, model: Model, variant: TabsVariant): Html =>
	h.span([
		h.Class(
			cn(
				tabsIndicatorStyles,
				variant === "underline" ? tabsIndicatorUnderlineStyles : tabsIndicatorDefaultStyles,
			),
		),
		...stateAttributes(h, model),
		h.DataAttribute("slot", "tab-indicator"),
		h.Role("presentation"),
		...Option.match(model.maybeIndicator, {
			onNone: () => [h.Hidden(true)],
			onSome: (rect) => [h.Attribute("style", indicatorStyle(rect))],
		}),
	])

const tabList = (
	h: H,
	model: Model,
	inputs: TabsViewInputs,
	rendered: ReadonlyArray<string>,
	panelValues: ReadonlyArray<string>,
): Html => {
	const variant = inputs.variant ?? "default"
	return h.div(
		[
			...(inputs.ariaLabel === undefined ? [] : [h.AriaLabel(inputs.ariaLabel)]),
			h.Class(
				cn(
					tabsListStyles,
					tabsListVerticalStyles,
					variant === "default" ? tabsListDefaultStyles : tabsListUnderlineStyles,
					inputs.listClassName,
				),
			),
			...stateAttributes(h, model),
			h.DataAttribute("slot", "tabs-list"),
			h.Role("tablist"),
			h.OnMount(MeasureTabIndicator()),
		],
		[
			...rendered.map((value) => {
				const index = model.values.indexOf(value)
				return tab(
					h,
					model,
					index,
					inputs.labels[index] ?? value,
					panelValues.includes(value),
					inputs.tabClassName,
					inputs.tabContent,
				)
			}),
			indicator(h, model, variant),
		],
	)
}

const tabPanel = (
	h: H,
	model: Model,
	inputs: TabsViewInputs,
	shown: string,
	index: number,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.AriaLabelledBy(tabId(model, model.values.indexOf(shown))),
			h.Class(cn(tabsPanelStyles, inputs.panelClassName, inputs.panelClassNameFor?.(shown))),
			...stateAttributes(h, model),
			h.DataAttribute("index", String(index)),
			h.DataAttribute("slot", "tabs-content"),
			h.Id(panelId(model)),
			h.Role("tabpanel"),
			h.Attribute("tabindex", "0"),
		],
		children,
	)

/** The Tabs root: list, then the shown value's panel (Base UI unmounts the others). */
export const view = TabsComposition.makeView.withInputs<TabsViewInputs>((model, inputs, h) => {
	const rendered = inputs.values ?? model.values
	const shown =
		inputs.fallbackValue !== undefined && !rendered.includes(model.selected)
			? inputs.fallbackValue
			: model.selected
	// Each panel is built once: a panel holding a child Block may only render it once per pass.
	const content = inputs.panel(shown)
	const hasPanel =
		inputs.hasPanel ??
		((value: string) => (value === shown ? content !== undefined : inputs.panel(value) !== undefined))
	const panelValues = rendered.filter(hasPanel)
	return h.div(
		[
			h.Class(cn(tabsStyles, inputs.className)),
			...stateAttributes(h, model),
			h.DataAttribute("slot", "tabs"),
		],
		[
			(inputs.wrapList ?? ((list: Html) => list))(tabList(h, model, inputs, rendered, panelValues)),
			...(content === undefined
				? []
				: [tabPanel(h, model, inputs, shown, panelValues.indexOf(shown), content)]),
		],
	)
})

// BLOCK

const prepare = () =>
	TabsComposition.prepareBlock({
		init,
		update,
		view,
		operations: {
			requestReset: Message.RequestedReset,
			requestSelect: Message.RequestedSelect,
			informOfSelection: Message.InformedOfSelection,
		},
		EffectsLayer,
	})
export const TabsBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
