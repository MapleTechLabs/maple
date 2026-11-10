import type { VercelAiGatewaySummary, VercelInfraRequestBucket } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { ERROR_RATE_TEXT } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	buildDurationMs,
	type VercelFleetTotals,
	type VercelProjectRow,
} from "../../../../components/infra/vercel/list-model"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { columnHead, dataTable, headSort, ROW_LINK_CLASS, skeletonRows } from "../../../infra/kit/data-table"
import type { TimeSearch } from "../../../infra/kit/view-tabs"
import { statRail, statRailItem, statRailItemSkeleton } from "../../../kit/stat-rail"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import {
	type Clock,
	deploymentInline,
	LEAD_COLUMN,
	errorText,
	errorTone,
	percentText,
	projectHref,
} from "../view-parts"
import { Message, type SortKey } from "./model"

/** The build time, or the empty value while it builds or when Vercel reported none. */
const buildDurationText = (deployment: Parameters<typeof buildDurationMs>[0]): string => {
	const ms = buildDurationMs(deployment)
	return ms === null ? EMPTY_VALUE : formatLatency(ms)
}

// `VercelHeadline` and `VercelProjectTable`.

type H = HtmlBuilder<Message>

/** Null while AI Gateway usage loads; "failed" when its read failed; "off" when its drain is. */
export type BandAiGateway =
	| Readonly<{ summary: VercelAiGatewaySummary; spark: ReadonlyArray<number> }>
	| "failed"
	| "off"
	| null

const spendItem = (h: H, aiGateway: BandAiGateway): Html =>
	aiGateway === null
		? statRailItemSkeleton(h)
		: aiGateway === "failed" || aiGateway === "off"
			? statRailItem(h, {
					eyebrow: "AI Gateway spend",
					value: EMPTY_VALUE,
					subline: aiGateway === "off" ? "drain off" : "couldn't load",
				})
			: statRailItem(h, {
					eyebrow: "AI Gateway spend",
					value:
						aiGateway.summary.requests > 0 ? formatCost(aiGateway.summary.costUsd) : EMPTY_VALUE,
					spark: aiGateway.spark,
					subline:
						aiGateway.summary.requests > 0
							? `${formatNumber(aiGateway.summary.requests)} requests`
							: "no requests",
				})

/** The team in five numbers: traffic, failures, cache, cold starts and AI Gateway spend. */
export const headline = (
	h: H,
	inputs: Readonly<{
		totals: VercelFleetTotals
		projectCount: number
		buckets: ReadonlyArray<VercelInfraRequestBucket>
		aiGateway: BandAiGateway
	}>,
): Html => {
	const { totals, buckets } = inputs
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Requests",
			value: formatNumber(totals.requests),
			spark: Arr.map(buckets, (row) => row.requests),
			subline: `across ${inputs.projectCount} ${inputs.projectCount === 1 ? "project" : "projects"}`,
		}),
		statRailItem(h, {
			eyebrow: "Error rate",
			value: errorText(totals.errorPercent),
			tone: errorTone(totals.errorPercent),
			spark: Arr.map(buckets, (row) => row.requests5xx),
			subline: `${formatNumber(totals.requests5xx)} 5xx responses`,
		}),
		statRailItem(h, {
			eyebrow: "Cache hit rate",
			value: percentText(totals.cacheHitPercent),
			spark: Arr.map(buckets, (row) => row.cacheHits),
			subline: totals.cacheHitPercent === null ? "no cache lookups" : "of cache lookups",
		}),
		statRailItem(h, {
			eyebrow: "Cold starts",
			value: percentText(totals.coldStartPercent),
			tone: errorTone(totals.coldStartPercent),
			subline:
				totals.coldStartPercent === null
					? "no function traces"
					: `${formatNumber(totals.coldStarts)} of ${formatNumber(totals.invocations)} invocations`,
		}),
		spendItem(h, inputs.aiGateway),
	])
}

export const headlineLoading = (h: H): Html =>
	statRail(
		h,
		{ columns: 5, isBusy: true },
		Array.from({ length: 5 }, () => statRailItemSkeleton(h)),
	)

interface RowView extends VercelProjectRow {
	readonly sortError: number
	readonly sortCache: number
	readonly sortColdStart: number
	readonly sortP95: number
}

// A missing rate or latency sorts below every real one.
const toView = (row: VercelProjectRow): RowView => ({
	...row,
	sortError: row.errorPercent ?? -1,
	sortCache: row.cacheHitPercent ?? -1,
	sortColdStart: row.coldStartPercent ?? -1,
	sortP95: row.p95DurationMs ?? -1,
})

const columns = (h: H, sort: Sort<SortKey> | null): ReadonlyArray<Html> => {
	const sorted = (label: string, key: SortKey, width: string, align?: "right", hidden?: string) =>
		columnHead(h, {
			label,
			width,
			align,
			hidden,
			sort: headSort(sort, key, (k) => Message.ClickedSort({ key: k })),
		})
	return [
		sorted("Project", "name", LEAD_COLUMN),
		columnHead(h, { label: "Last build", width: "w-[240px]", hidden: "hidden lg:flex" }),
		sorted("Requests", "requests", "w-[90px]", "right"),
		sorted("5xx", "sortError", "w-[72px]", "right"),
		sorted("Cache hits", "sortCache", "w-[80px]", "right", "hidden md:flex"),
		sorted("Cold starts", "sortColdStart", "w-[80px]", "right", "hidden md:flex"),
		sorted("p95", "sortP95", "w-[72px]", "right"),
		sorted("Error logs", "errorLogs", "w-[80px]", "right"),
	]
}

export const projectTableLoading = (h: H): Html =>
	dataTable(
		h,
		{ ariaLabel: "Vercel projects" },
		columns(h, null),
		skeletonRows(h, 5, () => [
			h.div([h.Class(LEAD_COLUMN)], [skeleton(h, "h-4 w-36")]),
			skeleton(h, "hidden h-3 w-[240px] lg:block"),
			skeleton(h, "ml-auto h-3 w-[90px]"),
			skeleton(h, "h-3 w-[72px]"),
			skeleton(h, "hidden h-3 w-[80px] md:block"),
			skeleton(h, "hidden h-3 w-[80px] md:block"),
			skeleton(h, "h-3 w-[72px]"),
			skeleton(h, "h-3 w-[80px]"),
		]),
	)

const NUM = "text-right font-mono text-xs tabular-nums"

const row = (h: H, view: RowView, time: TimeSearch, clock: Clock): Html =>
	h.a(
		[h.Key(view.projectId), h.Class(ROW_LINK_CLASS), h.Href(projectHref(view.projectId, time))],
		[
			hstack(h, { align: "baseline", gap: "2", grow: true, className: "w-0 min-w-[200px]" }, [
				h.span(
					[
						h.Class(
							"truncate font-mono text-xs font-medium text-foreground group-hover:text-primary",
						),
						h.Title(view.name),
					],
					[view.name],
				),
				...(view.framework === null
					? []
					: [
							typography(h, { size: "3xs", tone: "muted", mono: true, className: "shrink-0" }, [
								view.framework,
							]),
						]),
			]),
			hstack(h, { gap: "2", className: "hidden w-[240px] lg:flex" }, [
				...(view.latest === null
					? [typography(h, { size: "2xs", tone: "muted" }, ["no builds recorded"])]
					: [
							deploymentInline(h, view.latest, clock),
							typography(h, { size: "2xs", tone: "muted", mono: true, className: "shrink-0" }, [
								buildDurationText(view.latest),
							]),
						]),
			]),
			h.div(
				[
					h.Class(
						cn(
							NUM,
							"w-[90px]",
							view.requests === 0 ? "text-muted-foreground" : "text-foreground",
						),
					),
				],
				[formatNumber(view.requests)],
			),
			h.div(
				[h.Class(cn(NUM, "w-[72px]", ERROR_RATE_TEXT[errorTone(view.errorPercent)]))],
				[errorText(view.errorPercent)],
			),
			h.div(
				[h.Class(cn(NUM, "hidden w-[80px] text-foreground-soft md:block"))],
				[percentText(view.cacheHitPercent)],
			),
			h.div(
				[
					h.Class(
						cn(
							NUM,
							"hidden w-[80px] md:block",
							ERROR_RATE_TEXT[errorTone(view.coldStartPercent)],
						),
					),
					...(view.coldStartPercent === null ? [h.Title("No function invocations traced")] : []),
				],
				[percentText(view.coldStartPercent)],
			),
			h.div(
				[
					h.Class(
						cn(
							NUM,
							"w-[72px]",
							view.p95DurationMs === null ? "text-muted-foreground" : "text-foreground-soft",
						),
					),
					...(view.p95DurationMs === null
						? [h.Title("This project sends no deployment traces")]
						: []),
				],
				[view.p95DurationMs === null ? EMPTY_VALUE : formatLatency(view.p95DurationMs)],
			),
			h.div(
				[h.Class(cn(NUM, "w-[80px]", view.errorLogs > 0 ? TONE_TEXT.warn : "text-muted-foreground"))],
				[formatNumber(view.errorLogs)],
			),
		],
	)

export const projectTable = (
	h: H,
	inputs: Readonly<{
		rows: ReadonlyArray<VercelProjectRow>
		sort: Sort<SortKey>
		time: TimeSearch
		clock: Clock
	}>,
): Html =>
	dataTable(
		h,
		{ ariaLabel: "Vercel projects" },
		columns(h, inputs.sort),
		Arr.map(sortRowsByField<RowView, SortKey>(Arr.map(inputs.rows, toView), inputs.sort), (view) =>
			row(h, view, inputs.time, inputs.clock),
		),
	)
