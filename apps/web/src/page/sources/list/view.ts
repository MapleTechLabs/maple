import type { V2Source } from "@maple/domain/http/v2"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Option } from "effect"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../../ui/empty"
import { errorState } from "../../../ui/error-state"
import { icon } from "../../../ui/icon"
import { skeleton } from "../../../ui/skeleton"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { listToolbar, toolbarStat } from "../../kit/list-toolbar"
import { platformMeta, platformTile } from "../kit/platforms"
import { PULL_SOURCE_PLATFORMS, type PullSourcePlatform, type SourceId } from "@maple/domain/primitives"
import { AppRoute, hrefOf } from "../../../route"
import * as ToggleGroup from "../../../ui/toggle-group"
import { integrationPlatformOf, orderSources, sourceHref, viaLabel } from "../kit/shared"
import { needsAttention, sourceStatusBadge } from "../kit/status"
import { signalCounts, type VolumeTotals, volumeSize } from "../kit/volume"
import { countChipItem } from "../../integrations/kit/count-chip"
import { Message } from "./message"
import type { Model, SourceKind } from "./model"

type H = HtmlBuilder<Message>

// The whole row opens on click; the name is the real link for keyboards and screen readers.
const NAME_LINK_CLASS = "truncate text-sm font-medium outline-none hover:underline active:underline focus-visible:underline"

/** `outline` keeps one filled CTA on the page when the empty state shows its own. */
const connectButton = (h: H, variant?: "outline"): Html =>
	linkButton(h, { size: "sm", href: "/sources/new", variant }, [
		icon(h, "PlusIcon", {
			attributes: [h.DataAttribute("icon", "inline-start")],
			className: variant === "outline" ? "text-primary" : undefined,
		}),
		"Connect source",
	])

const hasNoAddedSources = (rows: ReadonlyArray<V2Source>): boolean =>
	rows.every((source) => source.is_default)

/** Mirrors `body`: the empty state renders once the list loaded with no added sources. */
const showsEmptyState = (model: Model): boolean =>
	model.nowMs !== null &&
	AsyncData.match(model.list.data, {
		onIdle: () => false,
		onLoading: () => false,
		onFailure: () => false,
		onStale: () => false,
		onSuccess: hasNoAddedSources,
		onRefreshing: hasNoAddedSources,
	})

/** Volume by source id: `null` while the summary loads, empty when it failed. */
type UsageBySource = ReadonlyMap<SourceId, VolumeTotals> | null

const usageBySource = (model: Model): UsageBySource =>
	AsyncData.isFailure(model.usage.data)
		? new Map()
		: Option.match(AsyncData.getData(model.usage.data), {
				onNone: () => null,
				onSome: (summary) => new Map(summary.data.map((entry) => [entry.source_id, entry])),
			})

const NO_VOLUME: VolumeTotals = { spans: 0, logs: 0, metrics: 0, bytes: 0 }

const volumeCell = (h: H, source: V2Source, usage: UsageBySource, isUnavailable: boolean): Html | string => {
	if (isUnavailable) return "-"
	if (usage === null) return skeleton(h, "h-4 w-16")
	const totals = usage.get(source.id) ?? NO_VOLUME
	return h.div(
		[h.Class("flex min-w-0 flex-col gap-0.5")],
		[
			h.span([h.Class("text-foreground tabular-nums")], [volumeSize(totals)]),
			h.span([h.Class("text-muted-foreground truncate text-xs")], [signalCounts(totals)]),
		],
	)
}

const sourceRow = (
	h: H,
	source: V2Source,
	nowMs: number,
	usage: UsageBySource,
	isUnavailable: boolean,
): Html => {
	const href = sourceHref(source)
	return tableRow(
		h,
		[
			tableCell(h, [
				h.div(
					[h.Class("flex min-w-0 items-center gap-3")],
					[
						platformTile(h, source.platform, "sm"),
						h.div(
							[h.Class("flex min-w-0 flex-col gap-0.5")],
							[
								h.a(
									[
										h.Href(href),
										h.Class(NAME_LINK_CLASS),
										h.OnClick(Message.ClickedSource({ url: href }), {
											defaultAction: "Prevent",
											propagation: "Stop",
										}),
									],
									[source.name],
								),
								h.span(
									[h.Class("text-muted-foreground truncate text-xs")],
									[
										`${platformMeta(source.platform).label}${source.is_default ? " · Default" : ""}`,
									],
								),
							],
						),
					],
				),
			]),
			tableCell(h, [sourceStatusBadge(h, source, { nowMs, showTime: false })]),
			tableCell(
				h,
				[
					source.health.last_data_at === null
						? "Never"
						: formatRelativeTime(source.health.last_data_at, nowMs),
				],
				"text-muted-foreground hidden sm:table-cell",
			),
			tableCell(
				h,
				[volumeCell(h, source, usage, isUnavailable)],
				"text-muted-foreground hidden text-sm md:table-cell",
			),
			tableCell(
				h,
				[viaLabel(source)],
				"text-muted-foreground hidden truncate font-mono text-xs sm:table-cell",
			),
			tableCell(h, [icon(h, "ChevronRightIcon", { size: 14, className: "text-muted-foreground" })]),
		],
		"cursor-pointer",
		[h.Key(source.id), h.OnClick(Message.ClickedSource({ url: href }))],
	)
}

const emptyState = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ConnectionIcon", { size: 16 })]),
				emptyTitle(h, ["Connect your first source"]),
				emptyDescription(h, [
					"Give each SDK, cluster or host its own source to see what it sends, cap its rate, or pause it on its own.",
				]),
			]),
			connectButton(h),
		],
		"py-8",
	)

const kindOf = (source: V2Source): Exclude<SourceKind, "all"> =>
	integrationPlatformOf(source) === null ? "push" : "integration"

const KIND_LABELS = { all: "All", push: "OpenTelemetry", integration: "Integrations" } as const

const kindChip = (h: H, kind: SourceKind, count: number): ToggleGroup.ToggleGroupItem =>
	countChipItem(h, { value: kind, label: KIND_LABELS[kind], count })

const kindFilter = (h: H, model: Model, sources: ReadonlyArray<V2Source>): Html =>
	ToggleGroup.view(h, {
		model: model.kindFilter,
		toParentMessage: (message) => Message.GotKindFilterMessage({ message }),
		isConnected: false,
		size: "xs",
		className: "gap-1.5",
		items: [
			kindChip(h, "all", sources.length),
			kindChip(h, "push", sources.filter((source) => kindOf(source) === "push").length),
			kindChip(h, "integration", sources.filter((source) => kindOf(source) === "integration").length),
		],
	})

const attentionFilter = (h: H, model: Model, sources: ReadonlyArray<V2Source>): Html | null => {
	const count = sources.filter(needsAttention).length
	return count === 0 && model.attentionFilter.values.length === 0
		? null
		: ToggleGroup.view(h, {
				model: model.attentionFilter,
				toParentMessage: (message) => Message.GotAttentionFilterMessage({ message }),
				isConnected: false,
				size: "xs",
				items: [
					countChipItem(h, { value: "attention", label: "Needs attention", count, tone: "warn" }),
				],
			})
}

/** Integrations nothing comes from yet: the on-ramp to pulling data in without an SDK. */
const availableStrip = (h: H, sources: ReadonlyArray<V2Source>): Html | null => {
	const present = new Set(sources.map((source) => source.platform))
	const missing = PULL_SOURCE_PLATFORMS.filter((platform: PullSourcePlatform) => !present.has(platform))
	if (missing.length === 0) return null
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2 rounded-md border border-dashed p-4")],
		[
			h.span([h.Class("text-muted-foreground mr-auto text-xs")], ["Pull more data in without an SDK"]),
			...missing.map((platform) =>
				linkButton(
					h,
					{
						size: "xs",
						variant: "outline",
						href: hrefOf(AppRoute.SourcesNew({ search: { integration: platform } })),
					},
					[icon(h, platformMeta(platform).icon, { size: 14 }), platformMeta(platform).label],
				),
			),
		],
	)
}

/** "1.2 GB stored in the last 24h" beside the filters: listed sources only, so a deleted one stops counting. */
const orgTotal = (
	h: H,
	sources: ReadonlyArray<V2Source>,
	usage: UsageBySource,
	isUnavailable: boolean,
): Html | null => {
	if (usage === null || isUnavailable) return null
	const totals = sources.reduce((sum, source) => {
		const entry = usage.get(source.id) ?? NO_VOLUME
		return {
			spans: sum.spans + entry.spans,
			logs: sum.logs + entry.logs,
			metrics: sum.metrics + entry.metrics,
			bytes: sum.bytes + entry.bytes,
		}
	}, NO_VOLUME)
	return toolbarStat(h, {
		value: volumeSize(totals),
		label: "stored in the last 24h",
		attributes: [h.Title(signalCounts(totals))],
	})
}

const sourcesTable = (h: H, model: Model, rows: ReadonlyArray<V2Source>, nowMs: number): Html => {
	const sources = orderSources(rows)
	const added = sources.filter((source) => !source.is_default)
	const kind = model.kindFilter.values[0] ?? "all"
	const ofKind = kind === "all" ? sources : sources.filter((source) => kindOf(source) === kind)
	const shown = model.attentionFilter.values.includes("attention") ? ofKind.filter(needsAttention) : ofKind
	const attention = attentionFilter(h, model, sources)
	const strip = availableStrip(h, sources)
	const usage = usageBySource(model)
	const isUnavailable = AsyncData.isFailure(model.usage.data)
	const total = orgTotal(h, sources, usage, isUnavailable)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			listToolbar(h, {
				className: "pb-0",
				leading: h.div(
					[h.Class("flex flex-wrap items-center gap-3")],
					[kindFilter(h, model, sources), ...(attention === null ? [] : [attention])],
				),
				trailing: total === null ? [] : [total],
			}),
			table(h, { variant: "card", className: "table-fixed" }, [
				tableHeader(h, [
					tableRow(h, [
						tableHead(h, ["Source"]),
						tableHead(h, ["Status"], "w-36 sm:w-48 lg:w-72"),
						tableHead(h, ["Last data"], "hidden w-28 sm:table-cell"),
						tableHead(h, ["Last 24h"], "hidden w-40 md:table-cell"),
						tableHead(h, ["Via"], "hidden w-44 sm:table-cell"),
						tableHead(h, [], "w-10"),
					]),
				]),
				tableBody(
					h,
					shown.map((source) => sourceRow(h, source, nowMs, usage, isUnavailable)),
				),
			]),
			...(added.length === 0
				? [emptyState(h)]
				: shown.length === 0
					? [emptyMessage(h, {}, ["No sources match these filters."])]
					: []),
			...(strip === null ? [] : [strip]),
		],
	)
}

const failed = (h: H, failure: Parameters<typeof errorState>[1]["failure"]): Html =>
	errorState(h, { failure, title: "Couldn't load sources", onRetry: Message.ClickedRetry() })

const body = (h: H, model: Model): Html => {
	const loading = skeleton(h, "h-48 w-full")
	const nowMs = model.nowMs
	if (nowMs === null) return loading
	return AsyncData.match(model.list.data, {
		onIdle: () => loading,
		onLoading: () => loading,
		onFailure: (failure) => failed(h, failure),
		onStale: ({ error }) => failed(h, error),
		onSuccess: (rows) => sourcesTable(h, model, rows, nowMs),
		onRefreshing: (rows) => sourcesTable(h, model, rows, nowMs),
	})
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(
		h,
		{ title: "Sources", actions: connectButton(h, showsEmptyState(model) ? "outline" : undefined) },
		[body(h, model)],
	),
)
