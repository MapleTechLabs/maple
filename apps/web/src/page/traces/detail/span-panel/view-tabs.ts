import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { skeletonListGapStyles, skeletonListStyles } from "@maple/ui/styles/ui/skeleton"
import {
	tabsIndicatorStyles,
	tabsIndicatorUnderlineStyles,
	tabsListStyles,
	tabsListUnderlineStyles,
	tabsListVerticalStyles,
	tabsPanelStyles,
	tabsStyles,
	tabsTabStyles,
} from "@maple/ui/styles/ui/tabs"
import { Option, Schema } from "effect"
import { AsyncData, Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { emptyMessage } from "../../../../ui/empty"
import { errorState } from "../../../../ui/error-state"
import { icon, type IconName } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import * as Tabs from "../../../../ui/tabs"
import { docsLink } from "../../../kit/signal-empty-state"
import { LOG_LIMIT } from "./command"
import { Message } from "./message"
import type { LogEntry, Model } from "./model"
import { TAB_VALUES } from "./update"
import { formatTimestamp } from "./view-header"

// The panel's Details / Logs / Infrastructure tabs: Base UI's Tabs DOM (`ui/tabs-view.ts`) with
// icon labels and the logs count badge, which that view's string labels cannot carry.

type H = HtmlBuilder<Message>
type TabValue = (typeof TAB_VALUES)[number]

const toTabs = (message: Tabs.Message) => Message.GotTabsMessage({ message })
const isTabKey = Schema.is(Tabs.TabKey)

const TAB_LABELS = {
	details: { icon: "CircleInfoIcon", text: " Details" },
	logs: { icon: "FileIcon", text: " Logs" },
	infrastructure: { icon: "ServerIcon", text: " Infrastructure" },
} as const satisfies Record<TabValue, { icon: IconName; text: string }>

const stateAttributes = (h: H, tabs: Tabs.Model) => [
	h.DataAttribute("activation-direction", tabs.activationDirection),
	h.DataAttribute("orientation", "horizontal"),
]

/** `logCountLabel`: the query stops at the limit, so a full page reads "100+". */
const logCount = (model: Model): string | null =>
	Option.match(AsyncData.getData(model.logs.data), {
		onNone: () => null,
		onSome: (logs) =>
			logs.length === 0 ? null : logs.length >= LOG_LIMIT ? `${LOG_LIMIT}+` : String(logs.length),
	})

const tab = (h: H, model: Model, value: TabValue): Html => {
	const { tabs } = model
	const index = tabs.values.indexOf(value)
	const isActive = value === tabs.selected
	const isHighlighted = index === tabs.highlightedIndex
	const count = value === "logs" ? logCount(model) : null
	return h.button(
		[
			...(isActive ? [h.AriaControls(Tabs.panelId(tabs))] : []),
			h.AriaDisabled(false),
			h.AriaSelected(isActive),
			h.Attribute("class", tabsTabStyles),
			...stateAttributes(h, tabs),
			...(isActive ? [h.DataAttribute("active", "")] : []),
			...(isHighlighted ? [h.DataAttribute("composite-item-active", "")] : []),
			h.DataAttribute("slot", "tabs-tab"),
			h.Id(Tabs.tabId(tabs, index)),
			h.Role("tab"),
			h.Attribute("tabindex", isHighlighted ? "0" : "-1"),
			h.Type("button"),
			h.OnClick(toTabs(Tabs.Message.ClickedTab({ index }))),
			h.OnKeyDownPreventDefault((key) =>
				isTabKey(key) ? Option.some(toTabs(Tabs.Message.PressedTabKey({ key }))) : Option.none(),
			),
		],
		[
			icon(h, TAB_LABELS[value].icon, { size: 14 }),
			TAB_LABELS[value].text,
			...(count === null
				? []
				: [badge(h, { variant: "secondary", size: "xs", className: "ml-1 px-1.5" }, [count])]),
		],
	)
}

const indicatorStyle = (rect: Tabs.IndicatorRect): string =>
	[
		`--active-tab-left: ${rect.left}px;`,
		`--active-tab-right: ${rect.right}px;`,
		`--active-tab-top: ${rect.top}px;`,
		`--active-tab-bottom: ${rect.bottom}px;`,
		`--active-tab-width: ${rect.width}px;`,
		`--active-tab-height: ${rect.height}px;`,
	].join(" ")

export const tabList = (h: H, model: Model, values: ReadonlyArray<TabValue>): Html =>
	h.div(
		[
			h.Class(
				cn(
					tabsListStyles,
					tabsListVerticalStyles,
					tabsListUnderlineStyles,
					"sticky top-0 z-10 w-full justify-start overflow-x-auto overflow-y-hidden bg-background px-4 *:data-[slot=tabs-tab]:grow-0",
				),
			),
			...stateAttributes(h, model.tabs),
			h.DataAttribute("slot", "tabs-list"),
			h.Role("tablist"),
			h.OnMount(Mount.mapMessage(Tabs.MeasureTabIndicator(), toTabs)),
		],
		[
			...values.map((value) => tab(h, model, value)),
			h.span([
				h.Class(cn(tabsIndicatorStyles, tabsIndicatorUnderlineStyles)),
				...stateAttributes(h, model.tabs),
				h.DataAttribute("slot", "tab-indicator"),
				h.Role("presentation"),
				...Option.match(model.tabs.maybeIndicator, {
					onNone: () => [h.Hidden(true)],
					onSome: (rect) => [h.Attribute("style", indicatorStyle(rect))],
				}),
			]),
		],
	)

/** `SeverityBadge` (packages/ui/src/components/logs/severity-badge.tsx), from the text only. */
const severityBadge = (h: H, severityText: string): Html => {
	const label = severityText.trim() === "" ? "UNSET" : severityText
	const color = getSeverityColor(label)
	return badge(
		h,
		{
			variant: "secondary",
			className: cn("font-mono text-3xs uppercase", "h-4 px-1"),
			attributes: [
				h.Style({ color, "background-color": `color-mix(in oklch, ${color} 10%, transparent)` }),
			],
		},
		[label],
	)
}

const logEntry = (h: H, log: LogEntry, timeZone: string): Html =>
	h.button(
		[h.Class("block w-full p-2 text-left hover:bg-muted/30 cursor-pointer"), h.Type("button")],
		[
			h.div(
				[h.Class("flex items-center gap-2 text-3xs text-muted-foreground mb-1")],
				[
					h.span([], [formatTimestamp(log.timestamp, timeZone, false)]),
					severityBadge(h, log.severityText),
				],
			),
			h.p([h.Class("font-mono text-xs whitespace-pre-wrap break-all line-clamp-3")], [log.body]),
		],
	)

/**
 * `SpanLogs`: the logs carrying this span's context.
 * TODO(log-sheet): a row click should open the log detail sheet; it is not wired here yet.
 */
export const spanLogs = (h: H, model: Pick<Model, "logs">, timeZone: string): Html =>
	AsyncData.matchData(model.logs.data, {
		onEmpty: () =>
			h.div(
				[
					h.AriaBusy(true),
					h.Class(cn(skeletonListStyles, skeletonListGapStyles["2"], "p-2")),
					h.DataAttribute("slot", "skeleton-list"),
				],
				Array.from({ length: 3 }, () =>
					h.div([h.Class("space-y-1")], [skeleton(h, "h-3 w-24"), skeleton(h, "h-4 w-full")]),
				),
			),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load logs", variant: "inline", className: "px-4" }),
		onData: (logs) =>
			logs.length === 0
				? emptyMessage(h, { className: "flex flex-col items-center gap-2" }, [
						"No logs carry this span's trace context. Logs link here when your log bridge runs inside the active span.",
						docsLink(h, "logs"),
					])
				: h.div(
						[h.Class("divide-y")],
						logs.map((log) => logEntry(h, log, timeZone)),
					),
	})

/** The Tabs root: list, then the selected value's panel (Base UI unmounts the others). */
export const tabsView = (
	h: H,
	model: Model,
	values: ReadonlyArray<TabValue>,
	panel: (value: TabValue) => ReadonlyArray<Html>,
): Html => {
	const selected = values.find((value) => value === model.tabs.selected) ?? "details"
	return h.div(
		[h.Class(cn(tabsStyles)), ...stateAttributes(h, model.tabs), h.DataAttribute("slot", "tabs")],
		[
			tabList(h, model, values),
			h.div(
				[
					h.AriaLabelledBy(Tabs.tabId(model.tabs, model.tabs.values.indexOf(selected))),
					h.Class(cn(tabsPanelStyles, "mt-0")),
					...stateAttributes(h, model.tabs),
					h.DataAttribute("index", String(values.indexOf(selected))),
					h.DataAttribute("slot", "tabs-content"),
					h.Id(Tabs.panelId(model.tabs)),
					h.Role("tabpanel"),
					h.Attribute("tabindex", "0"),
				],
				panel(selected),
			),
		],
	)
}
