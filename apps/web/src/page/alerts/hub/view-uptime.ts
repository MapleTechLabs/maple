import { countLabel, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "@maple/views/ui/button"
import { confirmDialog } from "@maple/views/ui/confirm-dialog"
import { badge } from "@maple/views/ui/display"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import * as Menu from "@maple/views/ui/menu"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { rowActionsMenu } from "@maple/views/ui/row-actions-menu"
import { searchInput } from "@maple/views/ui/search-input"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { skeleton } from "@maple/views/ui/skeleton"
import { ROW_LINK_LIFT, rowLink } from "@maple/views/ui/table"
import { emptyActions, filteredEmpty } from "@maple/views/ui/signal-empty-state"
import { listToolbar, toolbarStat } from "../../kit/list-toolbar"
import { monitorHref, newMonitorHref } from "../shared/uptime-commands"
import {
	displayStatus,
	formatMs,
	formatShare,
	KIND_LABEL,
	matchesQuery,
	latencyPercentiles,
	matchesStatus,
	type StatusFilter,
	summarize,
	targetLine,
	type UptimeMonitor,
	uptimeShare,
} from "../shared/uptime-derive"
import { recentChecksStrip, uptimeStatusChip, uptimeStatusSquare } from "../shared/uptime-view"
import { Message } from "./message"
import { canManage, type Model, type UptimeKindFilter } from "./model"
import { monitorMenuId } from "./update"
import {
	groupMonitors,
	type MonitorGroup,
	monitorNamespace,
	NO_NAMESPACE,
	type ServiceNamespaces,
} from "./uptime-groups"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { borderedBox } from "@maple/views/ui/bordered-box"

// The hub's Uptime tab: the filters with the readout, and the monitor table.

type H = HtmlBuilder<Message>

// The checks strip shares the slack with the name, so no column floats in dead space.
const ROW_GRID =
	"grid grid-cols-[minmax(220px,1.25fr)_minmax(160px,1fr)_56px_64px_64px_64px_28px] items-center gap-x-5"
const RECENT_SLOTS = 40

const KIND_FILTERS: ReadonlyArray<{ value: UptimeKindFilter; label: string }> = [
	{ value: "all", label: "All types" },
	{ value: "http", label: "HTTP" },
	{ value: "tcp", label: "TCP" },
	{ value: "dns", label: "DNS" },
	{ value: "heartbeat", label: "Heartbeat" },
]

const isKindFilter = (value: string): value is UptimeKindFilter =>
	Arr.some(KIND_FILTERS, (kind) => kind.value === value)

/** The empty org: what uptime checks are and the first one to add. */
const uptimeEmptyState = (h: H, serviceName: string | undefined, canEdit: boolean): Html =>
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
			...(canEdit
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

/** The window's figures as the toolbar readout: the total, what is down now and the recent uptime. */
const readout = (h: H, monitors: ReadonlyArray<UptimeMonitor>): ReadonlyArray<Html> => {
	const summary = summarize(monitors)
	const downNames = Arr.map(
		Arr.filter(monitors, (monitor) => displayStatus(monitor) === "down"),
		(monitor) => monitor.name,
	)
	return [
		toolbarStat(h, { value: String(summary.total), label: pluralize(summary.total, "monitor") }),
		toolbarStat(h, {
			value: String(summary.down),
			label: "down",
			dot: summary.down > 0 ? "crit" : undefined,
			// The rows sort down first; the tooltip names them without a scroll.
			attributes: downNames.length === 0 ? [] : [h.Title(Arr.join(downNames, ", "))],
		}),
		toolbarStat(h, {
			value: formatShare(summary.share),
			label: "uptime, recent checks",
			dot: summary.share !== null && summary.share < 1 ? "warn" : undefined,
		}),
	]
}

const statusSegments = (h: H, model: Model, monitors: ReadonlyArray<UptimeMonitor>): Html => {
	const count = (filter: StatusFilter) =>
		Arr.filter(monitors, (monitor) => matchesStatus(monitor, filter)).length
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
		options: Arr.map(options, (option) => ({
			value: option.value,
			label: `${option.label} ${count(option.value)}`,
			ariaLabel: `${option.label} ${count(option.value)}`,
		})),
	})
}

const toolbar = (h: H, model: Model, monitors: ReadonlyArray<UptimeMonitor>): Html =>
	listToolbar(h, {
		leading: statusSegments(h, model, monitors),
		className: "pb-0",
		trailing: [
			searchInput(h, {
				id: "uptime-filter",
				value: model.uptimeQuery,
				placeholder: "Filter monitors…",
				ariaLabel: "Filter monitors by name or target",
				onInput: (value) => Message.ChangedUptimeQuery({ value }),
				onClear: Message.ChangedUptimeQuery({ value: "" }),
				className: "w-64",
			}),
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
				Arr.map(KIND_FILTERS, (kind) => nativeOption(kind.value, kind.label)),
			),
			hstack(h, { gap: "3" }, readout(h, monitors)),
		],
	})

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

const PERCENTILE_COLUMNS = [
	{ key: "p50", label: "P50" },
	{ key: "p95", label: "P95" },
	{ key: "p99", label: "P99" },
] as const
const PERCENTILE_TITLE = "Response time over the monitor's recent checks"

/** P50, P95 and P99 of the recent checks; heartbeats have no response time. */
const latencyCells = (h: H, monitor: UptimeMonitor): ReadonlyArray<Html> => {
	const percentiles = latencyPercentiles(monitor.state.recent)
	return Arr.map(PERCENTILE_COLUMNS, (column) =>
		h.span(
			[
				h.Class(
					cn(
						typographyClass({ size: "xs", mono: true, numeric: true, className: "text-right" }),
						column.key === "p50" ? "text-foreground" : "text-muted-foreground",
					),
				),
			],
			[monitor.kind === "heartbeat" ? "–" : formatMs(percentiles[column.key])],
		),
	)
}

/** Type, then the target unless the name already says it: `HTTP · api.maple.dev/health`. */
const subline = (monitor: UptimeMonitor, nowMs: number): string => {
	const target = targetLine(monitor, nowMs)
	return target === monitor.name ? KIND_LABEL[monitor.kind] : `${KIND_LABEL[monitor.kind]} · ${target}`
}

const monitorRow = (h: H, model: Model, monitor: UptimeMonitor, nowMs: number): Html => {
	const isPaused = displayStatus(monitor) === "paused"
	const recent = monitor.state.recent
	return h.li(
		[
			h.Key(monitor.id),
			h.Class("relative py-3 pr-2 pl-4 hover:bg-surface-faint active:bg-surface-faint"),
		],
		[
			h.div(
				[h.Class(ROW_GRID)],
				[
					hstack(h, { gap: "3", align: "start", shrink: true }, [
						hstack(h, { align: "center", as: "span", className: "h-5 shrink-0" }, [
							uptimeStatusSquare(h, monitor),
						]),
						h.div(
							[h.Class("min-w-0")],
							[
								hstack(h, { gap: "2", shrink: true }, [
									rowLink(
										h,
										{
											href: monitorHref(monitor.id),
											className: typographyClass({
												size: "sm",
												weight: "medium",
												truncate: true,
											}),
										},
										[monitor.name],
									),
									...(displayStatus(monitor) === "up"
										? []
										: [uptimeStatusChip(h, monitor, nowMs)]),
								]),
								typography(
									h,
									{ size: "xs", tone: "muted", mono: true, truncate: true, as: "p" },
									[subline(monitor, nowMs)],
								),
							],
						),
					]),
					recentChecksStrip(h, { recent, slots: RECENT_SLOTS, isMuted: isPaused }),
					typography(h, { size: "xs", mono: true, numeric: true, className: "text-right" }, [
						isPaused ? "–" : formatShare(uptimeShare(recent)),
					]),
					...latencyCells(h, monitor),
					...(canManage(model) ? [rowMenu(h, model, monitor)] : [h.span([], [])]),
				],
			),
		],
	)
}

const namespaceLabel = (h: H, namespace: string): Html =>
	namespace === NO_NAMESPACE
		? badge(h, { variant: "secondary", className: "text-muted-foreground" }, ["No namespace"])
		: badge(h, { variant: "secondary" }, [namespace])

const groupHeader = (h: H, [namespace, monitors]: MonitorGroup): Html =>
	hstack(
		h,
		{
			gap: "2",
			align: "center",
			as: "li",
			className: "bg-surface-sunken py-2 pr-2 pl-4",
			attributes: [h.Key(`ns-${namespace}`)],
		},
		[
			namespaceLabel(h, namespace),
			typography(h, { size: "xs", tone: "muted" }, [countLabel(monitors.length, "monitor")]),
		],
	)

const table = (h: H, model: Model, groups: ReadonlyArray<MonitorGroup>, nowMs: number): Html =>
	borderedBox(h, { overflow: "x-auto" }, [
		h.div(
			[h.Class("min-w-[860px]")],
			[
				h.div(
					[h.Class(cn(ROW_GRID, "border-b py-2 pr-2 pl-4"))],
					[
						eyebrow(h, {}, ["Monitor"]),
						eyebrow(h, {}, ["Recent checks"]),
						eyebrow(h, { className: "text-right" }, ["Uptime"]),
						...Arr.map(PERCENTILE_COLUMNS, (column) =>
							eyebrow(h, { className: "text-right", attributes: [h.Title(PERCENTILE_TITLE)] }, [
								column.label,
							]),
						),
						h.span([], []),
					],
				),
				h.ul(
					[h.Class("divide-y")],
					Arr.flatMap(groups, (group) => [
						// One unnamed group is the plain list, no header.
						...(groups.length > 1 || group[0] !== NO_NAMESPACE ? [groupHeader(h, group)] : []),
						...Arr.map(group[1], (monitor) => monitorRow(h, model, monitor, nowMs)),
					]),
				),
			],
		),
	])

/**
 * The monitors in view: a pinned namespace keeps only its own, as the services list does, once the
 * namespaces are known. Unknown namespaces (still loading, or the read failed) leave the list whole.
 */
const scoped = (
	monitors: ReadonlyArray<UptimeMonitor>,
	namespaces: Option.Option<ServiceNamespaces>,
	pinnedNamespace: string | null,
): ReadonlyArray<UptimeMonitor> =>
	pinnedNamespace === null
		? monitors
		: Option.match(namespaces, {
				onNone: () => monitors,
				onSome: (known) =>
					Arr.filter(monitors, (monitor) => monitorNamespace(monitor, known) === pinnedNamespace),
			})

const loaded = (
	h: H,
	model: Model,
	all: ReadonlyArray<UptimeMonitor>,
	nowMs: number,
	pinnedNamespace: string | null,
): Html => {
	if (all.length === 0) return uptimeEmptyState(h, model.search.serviceName, canManage(model))
	const namespaces = AsyncData.getData(model.serviceNamespaces.data)
	const monitors = scoped(all, namespaces, pinnedNamespace)
	if (monitors.length === 0)
		return filteredEmpty(h, {
			noun: "monitors",
			description: `No monitor checks a service in the ${pinnedNamespace ?? ""} namespace. Clear the namespace pin to see every monitor.`,
		})
	const rows = Arr.filter(
		monitors,
		(monitor) =>
			matchesStatus(monitor, model.uptimeStatus) &&
			(model.uptimeKind === "all" || monitor.kind === model.uptimeKind) &&
			matchesQuery(monitor, model.uptimeQuery, nowMs),
	)
	return vstack(h, { gap: "4" }, [
		toolbar(h, model, monitors),
		rows.length === 0
			? filteredEmpty(h, {
					noun: "monitors",
					description: "Nothing matches the search, status and type.",
					onClear: Message.ClickedClearUptimeFilters(),
					clearLabel: "Clear filters",
				})
			: table(
					h,
					model,
					// Pinned to one namespace, the groups would be one header over the whole list.
					pinnedNamespace === null
						? groupMonitors(
								rows,
								Option.getOrElse(namespaces, () => ({})),
							)
						: [[NO_NAMESPACE, rows]],
					nowMs,
				),
	])
}

export const uptimeTab = (h: H, model: Model, nowMs: number, pinnedNamespace: string | null): Html => {
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
		onSome: (monitors) => loaded(h, model, monitors, nowMs, pinnedNamespace),
	})
}

const loadingState = (h: H): Html =>
	vstack(h, { gap: "4" }, [skeleton(h, "h-9 w-2/3"), skeleton(h, "h-64 w-full")])

export const deleteMonitorDialog = (h: H, model: Model): Html => {
	const monitors = AsyncData.getOrElse(model.monitors.data, () => [])
	const targetName = Option.getOrElse(
		Option.flatMapNullishOr(
			Arr.findFirst(monitors, (monitor) => monitor.id === model.confirmDeleteMonitorId),
			(monitor) => monitor.name,
		),
		() => "monitor",
	)
	return confirmDialog(h, {
		slotId: "alerts-delete-monitor",
		model: model.deleteMonitorDialog,
		toParentMessage: (message) => Message.GotDeleteMonitorDialogMessage({ message }),
		title: `Delete ${targetName}?`,
		description:
			"Maple stops checking it and its incidents close. Recorded check traces stay. This cannot be undone.",
		confirmLabel: "Delete monitor",
		isPending: model.deletingMonitorId !== null,
		onConfirm: Message.ClickedConfirmDeleteMonitor(),
	})
}
