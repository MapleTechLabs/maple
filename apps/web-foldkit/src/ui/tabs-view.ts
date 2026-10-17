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
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { type IndicatorRect, MeasureTabIndicator, Message, type Model, panelId, TabKey, tabId } from "./tabs"

// Base UI's Tabs DOM: the same data attributes, roles, roving tabindex and `useId` ids.

export type TabsVariant = "default" | "underline"

export interface TabsViewInputs {
	readonly variant?: TabsVariant
	/** One label per `model.values` entry. */
	readonly labels: ReadonlyArray<string>
	readonly className?: string
	/** `<TabsList className>`. */
	readonly listClassName?: string
	/** A tab's children when more than its label (an icon before it). */
	readonly tabContent?: (index: number, label: string) => ReadonlyArray<Html | string>
	readonly panelClassName?: string
	/** Panel content for a value; values without one render no panel (Base UI unmounts it). */
	readonly panel: (value: string) => ReadonlyArray<Html | string> | undefined
	/** Which values have a panel, without building them (a panel holding a Submodel renders once). */
	readonly hasPanel?: (value: string) => boolean
}

type H = HtmlBuilder<Message>

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
	hasPanel: boolean,
	content: ReadonlyArray<Html | string>,
): Html => {
	const value = model.values[index]
	const isActive = value === model.selected
	const isHighlighted = index === model.highlightedIndex
	return h.button(
		[
			...(isActive && hasPanel ? [h.AriaControls(panelId(model))] : []),
			h.AriaDisabled(false),
			h.AriaSelected(isActive),
			h.Attribute("class", tabsTabStyles),
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
		content,
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

const tabList = (h: H, model: Model, inputs: TabsViewInputs, panelValues: ReadonlyArray<string>): Html => {
	const variant = inputs.variant ?? "default"
	return h.div(
		[
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
			...model.values.map((value, index) => {
				const label = inputs.labels[index] ?? value
				const content = inputs.tabContent === undefined ? [label] : inputs.tabContent(index, label)
				return tab(h, model, index, panelValues.includes(value), content)
			}),
			indicator(h, model, variant),
		],
	)
}

const tabPanel = (
	h: H,
	model: Model,
	inputs: TabsViewInputs,
	index: number,
	children: ReadonlyArray<Html | string>,
): Html =>
	h.div(
		[
			h.AriaLabelledBy(tabId(model, model.values.indexOf(model.selected))),
			h.Class(cn(tabsPanelStyles, inputs.panelClassName)),
			...stateAttributes(h, model),
			h.DataAttribute("index", String(index)),
			h.DataAttribute("slot", "tabs-content"),
			h.Id(panelId(model)),
			h.Role("tabpanel"),
			h.Attribute("tabindex", "0"),
		],
		children,
	)

export const view = defineView<Model, Message, TabsViewInputs>((model, inputs, h) => {
	const hasPanel = inputs.hasPanel ?? ((value: string) => inputs.panel(value) !== undefined)
	const panelValues = model.values.filter(hasPanel)
	const content = inputs.panel(model.selected)
	return h.div(
		[
			h.Class(cn(tabsStyles, inputs.className)),
			...stateAttributes(h, model),
			h.DataAttribute("slot", "tabs"),
		],
		[
			tabList(h, model, inputs, panelValues),
			...(content === undefined
				? []
				: [tabPanel(h, model, inputs, panelValues.indexOf(model.selected), content)]),
		],
	)
})
