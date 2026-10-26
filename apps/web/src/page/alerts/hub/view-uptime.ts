import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import * as Menu from "../../../ui/menu"
import type { MenuEntry } from "../../../ui/menu-view"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { rowActionsMenu } from "../../../ui/row-actions-menu"
import { searchInput } from "../../../ui/search-input"
import { segmentedSelect } from "../../../ui/segmented-select"
import { skeleton } from "../../../ui/skeleton"
import { emptyActions, filteredEmpty } from "../../kit/signal-empty-state"
import { statRail, statRailItem, statRailLoading } from "../../kit/stat-rail"
import { ROW_LINK_LIFT, ROW_STRETCHED_LINK_CLASS } from "../shared/links"
import { isoMs } from "../shared/time"
import { monitorHref, newMonitorHref } from "../shared/uptime-commands"
import {
	displayStatus,
	formatMs,
	formatShare,
	formatSpan,
	KIND_LABEL,
	matchesQuery,
	matchesStatus,
	p95,
	type StatusFilter,
	summarize,
	targetLine,
	type UptimeMonitor,
	uptimeShare,
} from "../shared/uptime-derive"
import { recentChecksStrip, uptimeStatusChip, uptimeStatusSquare } from "../shared/uptime-view"
import { Message } from "./message"
import type { Model, UptimeKindFilter } from "./model"
import { monitorMenuId } from "./update"

// The hub's Uptime tab: the KPI rail, the filters and the monitor table.

type H = HtmlBuilder<Message>

const ROW_GRID = "grid grid-cols-[minmax(0,1fr)_80px_minmax(120px,240px)_72px_72px_32px] items-center gap-4"
const RECENT_SLOTS = 40

const KIND_FILTERS: ReadonlyArray<{ value: UptimeKindFilter; label: string }> = [
	{ value: "all", label: "All types" },
	{ value: "http", label: "HTTP" },
	{ value: "tcp", label: "TCP" },
	{ value: "dns", label: "DNS" },
	{ value: "heartbeat", label: "Heartbeat" },
]

const isKindFilter = (value: string): value is UptimeKindFilter =>
	KIND_FILTERS.some((kind) => kind.value === value)

/** The empty org: what uptime checks are and the first one to add. */
const uptimeEmptyState = (h: H, serviceName: string | undefined, isAdmin: boolean): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "GlobeIcon", { size: 18 })]),
				emptyTitle(h, ["No uptime checks yet"]),
				emptyDescription(h, [
					"Maple checks a URL, port or DNS record from outside on a schedule, or waits for your cron job to ping it. Each check is a trace, and a failing one opens an incident.",
				]),
			]),
			...(isAdmin
				? [
						emptyActions(h, [
							linkButton(h, { size: "sm", href: newMonitorHref({ serviceName }) }, [
								icon(h, "PlusIcon"),
								"New uptime check",
							]),
						]),
					]
				: []),
		],
		"py-12",
	)

const kpis = (h: H, monitors: ReadonlyArray<UptimeMonitor>, nowMs: number): Html => {
	const summary = summarize(monitors)
	const down = monitors.filter((monitor) => displayStatus(monitor) === "down")
	const firstDown = down[0]
	return statRail(h, { columns: 3 }, [
		statRailItem(h, {
			eyebrow: "Monitors",
			value: String(summary.total),
			compact: true,
			subline: `${summary.up} up · ${summary.down} down · ${summary.paused} paused`,
		}),
		statRailItem(h, {
			eyebrow: "Down now",
			value: String(summary.down),
			tone: summary.down > 0 ? "crit" : "neutral",
			compact: true,
			subline:
				firstDown === undefined
					? "Every active check passes"
					: down.length > 1
						? `${firstDown.name} and ${down.length - 1} more`
						: firstDown.state.status_changed_at === null
							? firstDown.name
							: `${firstDown.name} for ${formatSpan(nowMs - isoMs(firstDown.state.status_changed_at))}`,
		}),
		statRailItem(h, {
			eyebrow: "Uptime, recent checks",
			value: formatShare(summary.share),
			tone: summary.share !== null && summary.share < 1 ? "warn" : "neutral",
			compact: true,
			subline: "Across the last checks of every active monitor",
		}),
	])
}

const statusSegments = (h: H, model: Model, monitors: ReadonlyArray<UptimeMonitor>): Html => {
	const count = (filter: StatusFilter) =>
		monitors.filter((monitor) => matchesStatus(monitor, filter)).length
	const options: ReadonlyArray<{ value: StatusFilter; label: string }> = [
		{ value: "all", label: "All" },
		{ value: "down", label: "Down" },
		{ value: "degraded", label: "Degraded" },
		{ value: "paused", label: "Paused" },
	]
	return segmentedSelect(h, {
		ariaLabel: "Monitor status",
		size: "sm",
		value: model.uptimeStatus,
		onChange: (filter) => Message.ClickedUptimeStatus({ filter }),
		options: options.map((option) => ({
			value: option.value,
			label: `${option.label} ${count(option.value)}`,
			ariaLabel: `${option.label} ${count(option.value)}`,
		})),
	})
}

const toolbar = (h: H, model: Model, monitors: ReadonlyArray<UptimeMonitor>): Html =>
	h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			searchInput(h, {
				id: "uptime-filter",
				value: model.uptimeQuery,
				placeholder: "Filter monitors…",
				ariaLabel: "Filter monitors by name or target",
				onInput: (value) => Message.ChangedUptimeQuery({ value }),
				onClear: Message.ChangedUptimeQuery({ value: "" }),
				className: "w-64",
			}),
			statusSegments(h, model, monitors),
			nativeSelect(
				h,
				{
					size: "sm",
					className: "w-36",
					defaultValue: model.uptimeKind,
					attributes: [
						// Keyed on the filter: the select is uncontrolled, so a reset must rebuild it.
						h.Key(`uptime-kind-${model.uptimeKind}`),
						h.AriaLabel("Monitor type"),
						h.OnChange((value) =>
							Message.ChangedUptimeKind({ kind: isKindFilter(value) ? value : "all" }),
						),
					],
				},
				KIND_FILTERS.map((kind) => nativeOption(kind.value, kind.label)),
			),
		],
	)

const rowMenu = (h: H, model: Model, monitor: UptimeMonitor): Html => {
	const menuId = monitorMenuId(monitor.id)
	const entries: ReadonlyArray<MenuEntry> = [
		{
			_tag: "Item",
			value: "toggle",
			label: monitor.enabled ? "Pause" : "Resume",
			icon: monitor.enabled ? "MediaPauseIcon" : "MediaPlayIcon",
			isDisabled: model.togglingMonitorIds.includes(monitor.id),
		},
		{ _tag: "Item", value: "edit", label: "Edit", icon: "PencilIcon" },
		{ _tag: "Separator" },
		{ _tag: "Item", value: "delete", label: "Delete", icon: "TrashIcon", variant: "destructive" },
	]
	return rowActionsMenu(h, {
		slotId: menuId,
		model: model.menus[menuId] ?? Menu.init(menuId),
		entries,
		label: `Actions for ${monitor.name}`,
		className: ROW_LINK_LIFT,
		toParentMessage: (message) => Message.GotRowMenuMessage({ menuId, message }),
	})
}

const monitorRow = (h: H, model: Model, monitor: UptimeMonitor, nowMs: number): Html => {
	const isPaused = displayStatus(monitor) === "paused"
	const recent = monitor.state.recent
	return h.li(
		[h.Key(monitor.id), h.Class("relative px-4 py-3 hover:bg-muted/25")],
		[
			h.div(
				[h.Class(ROW_GRID)],
				[
					h.div(
						[h.Class("flex min-w-0 items-start gap-3")],
						[
							h.span([h.Class("mt-1.5")], [uptimeStatusSquare(h, monitor)]),
							h.div(
								[h.Class("min-w-0")],
								[
									h.div(
										[h.Class("flex min-w-0 items-center gap-2")],
										[
											h.a(
												[
													h.Href(monitorHref(monitor.id)),
													h.Class(
														cn(
															"truncate text-sm font-medium",
															ROW_STRETCHED_LINK_CLASS,
														),
													),
												],
												[monitor.name],
											),
											...(displayStatus(monitor) === "up"
												? []
												: [uptimeStatusChip(h, monitor, nowMs)]),
										],
									),
									h.p(
										[h.Class("truncate font-mono text-xs text-muted-foreground")],
										[targetLine(monitor, nowMs)],
									),
								],
							),
						],
					),
					h.span([h.Class("text-xs text-muted-foreground")], [KIND_LABEL[monitor.kind]]),
					recentChecksStrip(h, { recent, slots: RECENT_SLOTS, isMuted: isPaused }),
					h.span(
						[h.Class("text-right font-mono text-xs tabular-nums")],
						[isPaused ? "–" : formatShare(uptimeShare(recent))],
					),
					h.span(
						[h.Class("text-right font-mono text-xs tabular-nums text-muted-foreground")],
						[monitor.kind === "heartbeat" ? "–" : formatMs(p95(recent))],
					),
					...(model.isAdmin ? [rowMenu(h, model, monitor)] : [h.span([], [])]),
				],
			),
		],
	)
}

const table = (h: H, model: Model, rows: ReadonlyArray<UptimeMonitor>, nowMs: number): Html =>
	h.div(
		[h.Class("overflow-x-auto rounded-md border")],
		[
			h.div(
				[h.Class("min-w-[860px]")],
				[
					h.div(
						[h.Class(cn(ROW_GRID, "border-b px-4 py-2"))],
						[
							eyebrow(h, {}, ["Monitor"]),
							eyebrow(h, {}, ["Type"]),
							eyebrow(h, {}, ["Recent checks"]),
							eyebrow(h, { className: "text-right" }, ["Uptime"]),
							eyebrow(h, { className: "text-right" }, ["P95"]),
							h.span([], []),
						],
					),
					h.ul(
						[h.Class("divide-y")],
						rows.map((monitor) => monitorRow(h, model, monitor, nowMs)),
					),
				],
			),
		],
	)

const loaded = (h: H, model: Model, monitors: ReadonlyArray<UptimeMonitor>, nowMs: number): Html => {
	if (monitors.length === 0) return uptimeEmptyState(h, model.search.serviceName, model.isAdmin)
	const rows = monitors.filter(
		(monitor) =>
			matchesStatus(monitor, model.uptimeStatus) &&
			(model.uptimeKind === "all" || monitor.kind === model.uptimeKind) &&
			matchesQuery(monitor, model.uptimeQuery, nowMs),
	)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			kpis(h, monitors, nowMs),
			toolbar(h, model, monitors),
			rows.length === 0
				? filteredEmpty(h, {
						noun: "monitors",
						description: "No monitor matches the filter, status and type.",
						onClear: Message.ClickedClearUptimeFilters(),
						clearLabel: "Clear filters",
					})
				: table(h, model, rows, nowMs),
		],
	)
}

export const uptimeTab = (h: H, model: Model, nowMs: number): Html => {
	const data = model.monitors.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load monitors",
			onRetry: Message.ClickedRetryMonitors(),
			className: "py-12",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () => loadingState(h),
		onSome: (monitors) => loaded(h, model, monitors, nowMs),
	})
}

const loadingState = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-4")],
		[statRailLoading(h, 3, 3), skeleton(h, "h-9 w-2/3"), skeleton(h, "h-64 w-full")],
	)

export const deleteMonitorDialog = (h: H, model: Model): Html => {
	const monitors = AsyncData.getOrElse(model.monitors.data, () => [])
	const target = monitors.find((monitor) => monitor.id === model.confirmDeleteMonitorId)
	return confirmDialog(h, {
		slotId: "alerts-delete-monitor",
		model: model.deleteMonitorDialog,
		toParentMessage: (message) => Message.GotDeleteMonitorDialogMessage({ message }),
		title: `Delete ${target?.name ?? "monitor"}?`,
		description:
			"Maple stops checking it and its incidents close. Recorded check traces stay. This cannot be undone.",
		confirmLabel: "Delete monitor",
		isPending: model.deletingMonitorId !== null,
		onConfirm: Message.ClickedConfirmDeleteMonitor(),
	})
}
