import { getSeverityColor } from "@maple/ui/lib/severity"
import { cn } from "@maple/ui/lib/utils"
import { skeletonListGapStyles, skeletonListStyles } from "@maple/ui/styles/ui/skeleton"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../../ui/display"
import { emptyMessage } from "../../../../ui/empty"
import { type AutoRetryMountRequirements, errorState } from "../../../../ui/error-state"
import { icon, type IconName } from "../../../../ui/icon"
import { skeleton } from "../../../../ui/skeleton"
import { docsLink } from "../../../kit/signal-empty-state"
import { LOG_LIMIT } from "./command"
import { type SpanPanelViewBuilder, TAB_VALUES, TabsBinding } from "./composition"
import type { Message } from "./message"
import type { LogEntry, Model } from "./model"
import { formatTimestamp } from "./view-header"

// The panel's Details / Logs / Infrastructure tabs: the Tabs Block's Base UI DOM with icon labels
// and the logs count badge.

/** What the Logs tab needs of a builder: the panel's Messages and errorState's retry Mount. */
type H<P> = HtmlBuilder<Message | P, AutoRetryMountRequirements>
type TabValue = (typeof TAB_VALUES)[number]

const TAB_LABELS = {
	details: { icon: "CircleInfoIcon", text: " Details" },
	logs: { icon: "FileIcon", text: " Logs" },
	infrastructure: { icon: "ServerIcon", text: " Infrastructure" },
} as const satisfies Record<TabValue, { icon: IconName; text: string }>

const isTabValue = (value: string): value is TabValue => value in TAB_LABELS

/** `logCountLabel`: the query stops at the limit, so a full page reads "100+". */
const logCount = (model: Model): string | null =>
	Option.match(AsyncData.getData(model.logs.data), {
		onNone: () => null,
		onSome: (logs) =>
			logs.length === 0 ? null : logs.length >= LOG_LIMIT ? `${LOG_LIMIT}+` : String(logs.length),
	})

const tabContent = (
	h: SpanPanelViewBuilder,
	model: Model,
	value: string,
	label: string,
): ReadonlyArray<Html | string> => {
	if (!isTabValue(value)) return [label]
	const count = value === "logs" ? logCount(model) : null
	return [
		icon(h, TAB_LABELS[value].icon, { size: 14 }),
		label,
		...(count === null
			? []
			: [badge(h, { variant: "secondary", size: "xs", className: "ml-1 px-1.5" }, [count])]),
	]
}

/** `SeverityBadge` (packages/ui/src/components/logs/severity-badge.tsx), from the text only. */
const severityBadge = <P>(h: H<P>, severityText: string): Html => {
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

const logEntry = <P>(h: H<P>, log: LogEntry, timeZone: string): Html =>
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
export const spanLogs = <P>(h: H<P>, model: Pick<Model, "logs">, timeZone: string): Html =>
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
	h: SpanPanelViewBuilder,
	model: Model,
	values: ReadonlyArray<TabValue>,
	panel: (value: TabValue) => ReadonlyArray<Html>,
): Html =>
	h.block(
		TabsBinding.embedView({
			slotId: "span-panel-tabs",
			model: model.tabs,
			viewInputs: {
				variant: "underline",
				values,
				fallbackValue: "details",
				labels: model.tabs.values.map((value) =>
					isTabValue(value) ? TAB_LABELS[value].text : value,
				),
				tabContent: (value, label) => tabContent(h, model, value, label),
				listClassName:
					"sticky top-0 z-10 w-full justify-start overflow-x-auto overflow-y-hidden bg-background px-4 *:data-[slot=tabs-tab]:grow-0",
				panelClassName: "mt-0",
				panel: (value) => panel(isTabValue(value) ? value : "details"),
				// Each panel is built once per pass: the Infrastructure tab holds a child Block.
				hasPanel: () => true,
			},
		}),
	)
