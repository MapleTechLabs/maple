import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { emptyMessage } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon, type IconName } from "@maple/views/ui/icon"
import { severityBadge } from "@maple/views/ui/logs/severity-badge"
import { pressable } from "@maple/views/ui/pressable"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import * as TabsView from "@maple/views/ui/tabs-view"
import { timestamp } from "@maple/views/ui/timestamp"
import { docsLink } from "@maple/views/ui/docs-link"
import { LOG_LIMIT } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import type { LogEntry } from "../trace-source"
import { TAB_VALUES } from "./update"
import { hstack } from "../../ui/stack"
import { typography } from "../../ui/typography"

// The panel's Details / Logs / Infrastructure tabs on `@maple/views/ui/tabs-view.ts`, with icon labels and the
// logs count badge.

type H = HtmlBuilder<Message>
type TabValue = (typeof TAB_VALUES)[number]

const TAB_LABELS = {
	details: { icon: "CircleInfoIcon", text: " Details" },
	logs: { icon: "FileIcon", text: " Logs" },
	infrastructure: { icon: "ServerIcon", text: " Infrastructure" },
} as const satisfies Record<TabValue, { icon: IconName; text: string }>

/** `logCountLabel`: the query stops at the limit, so a full page reads "100+". */
const logCount = (model: Model): string | null =>
	Option.match(AsyncData.getData(model.logs.data), {
		onNone: () => null,
		onSome: (logs) =>
			logs.length === 0 ? null : logs.length >= LOG_LIMIT ? `${LOG_LIMIT}+` : String(logs.length),
	})

const logEntry = (h: H, log: LogEntry, timeZone: string): Html =>
	pressable(
		h,
		{
			className:
				"block w-full p-2 text-left hover:bg-surface-sunken active:bg-surface-sunken cursor-pointer",
			onClick: Message.ClickedLog({ key: log.key }),
		},
		[
			hstack(h, { gap: "2", align: "center", className: "text-3xs text-muted-foreground mb-1" }, [
				timestamp(h, { value: log.timestamp, timeZone, className: "cursor-pointer" }),
				severityBadge(h, { severity: log.severityText, className: "h-4 px-1" }),
			]),
			typography(
				h,
				{ size: "xs", mono: true, as: "p", className: "whitespace-pre-wrap break-all line-clamp-3" },
				[log.body],
			),
		],
	)

/** `SpanLogs`: the logs carrying this span's context. A row click asks the page to open that log. */
export const spanLogs = (h: H, model: Pick<Model, "logs">, timeZone: string, docsHref?: string): Html =>
	AsyncData.matchData(model.logs.data, {
		onEmpty: () =>
			skeletonList(h, {
				rows: 3,
				gap: "2",
				className: "p-2",
				renderRow: () =>
					h.div([h.Class("space-y-1")], [skeleton(h, "h-3 w-24"), skeleton(h, "h-4 w-full")]),
			}),
		onFailure: (failure) =>
			errorState(h, { failure, title: "Couldn't load logs", variant: "inline", className: "px-4" }),
		onData: (logs) =>
			logs.length === 0
				? emptyMessage(h, { className: "flex flex-col items-center gap-2" }, [
						"No logs carry this span's trace context. Logs link here when your log bridge runs inside the active span.",
						...(docsHref === undefined ? [] : [docsLink(h, docsHref)]),
					])
				: h.div(
						[h.Class("divide-y")],
						Arr.map(logs, (log) => logEntry(h, log, timeZone)),
					),
	})

/** The Tabs root: list, then the selected value's panel (Base UI unmounts the others). */
export const tabsView = (
	h: H,
	model: Model,
	values: ReadonlyArray<TabValue>,
	panel: (value: TabValue) => ReadonlyArray<Html>,
): Html => {
	const shownOf = (value: string): TabValue =>
		Option.getOrElse(
			Arr.findFirst(values, (shown) => shown === value),
			(): TabValue => "details",
		)
	return h.submodel({
		slotId: `span-panel-tabs-${model.tabs.idBase}`,
		model: { ...model.tabs, values },
		view: TabsView.view,
		viewInputs: {
			variant: "underline",
			labels: Arr.map(values, (value) => TAB_LABELS[value].text),
			listClassName:
				"sticky top-0 z-10 w-full justify-start overflow-x-auto overflow-y-hidden bg-background px-4 *:data-[slot=tabs-tab]:grow-0",
			panelClassName: "mt-0",
			tabContent: (value, label) => {
				const count = value === "logs" ? logCount(model) : null
				return [
					icon(h, TAB_LABELS[shownOf(value)].icon, { size: 14 }),
					label,
					...(count === null
						? []
						: [
								badge(h, { variant: "secondary", size: "xs", className: "ml-1 px-1.5" }, [
									count,
								]),
							]),
				]
			},
			panel: (value) => panel(shownOf(value)),
			hasPanel: () => true,
		},
		toParentMessage: (message) => Message.GotTabsMessage({ message }),
	})
}
