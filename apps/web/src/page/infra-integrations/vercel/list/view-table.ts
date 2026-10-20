import type { VercelAiGatewaySummary, VercelInfraRequestBucket } from "@maple/domain/http"
import { formatCost } from "@maple/agent-sessions"
import { ERROR_RATE_TEXT } from "@maple/ui/lib/error-rate"
import { EMPTY_VALUE, formatLatency, formatNumber } from "@maple/ui/lib/format"
import { TONE_TEXT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { VercelFleetTotals, VercelProjectRow } from "../../../../components/infra/vercel/list-model"
import { skeleton } from "../../../../ui/skeleton"
import { columnHead, dataTable, headSort, ROW_LINK_CLASS, skeletonRows } from "../../../infra/kit/data-table"
import type { TimeSearch } from "../../../infra/kit/view-tabs"
import { statRail, statRailItem, statRailItemSkeleton } from "../../../kit/stat-rail"
import { type Sort, sortRowsByField } from "../../../kit/table-sort"
import { type Clock, deploymentInline, errorText, errorTone, percentText, projectHref } from "../view-parts"
import { Message, type SortKey } from "./model"

// `VercelFleetBand` and `VercelProjectTable`.

type H = HtmlBuilder<Message>

/** Null while AI Gateway usage loads; "failed" when its read failed. */
export type BandAiGateway =
	| Readonly<{ summary: VercelAiGatewaySummary; spark: ReadonlyArray<number> }>
	| "failed"
	| null

const openAiGateway = Message.ClickedView({ view: "aiGateway" })

/** The fleet in five numbers. The spend cell opens the AI Gateway view. */
export const fleetBand = (
	h: H,
	inputs: Readonly<{
		totals: VercelFleetTotals
		projectCount: number
		buckets: ReadonlyArray<VercelInfraRequestBucket>
		aiGateway: BandAiGateway
	}>,
): Html => {
	const { totals, buckets, aiGateway } = inputs
	const spend =
		aiGateway === null
			? statRailItemSkeleton(h)
			: aiGateway === "failed"
				? statRailItem(h, {
						eyebrow: "AI Gateway spend",
						value: EMPTY_VALUE,
						subline: "couldn't load · see why",
						onSelect: openAiGateway,
						ariaLabel: "Open AI Gateway usage",
					})
				: statRailItem(h, {
						eyebrow: "AI Gateway spend",
						value:
							aiGateway.summary.requests > 0
								? formatCost(aiGateway.summary.costUsd)
								: EMPTY_VALUE,
						spark: aiGateway.spark,
						subline:
							aiGateway.summary.requests > 0
								? `${formatNumber(aiGateway.summary.requests)} requests · by model`
								: "no requests · see setup",
						onSelect: openAiGateway,
						ariaLabel: "Open AI Gateway usage",
					})
	return statRail(h, { columns: 5 }, [
		statRailItem(h, {
			eyebrow: "Requests",
			value: formatNumber(totals.requests),
			spark: buckets.map((row) => row.requests),
			subline: `across ${inputs.projectCount} ${inputs.projectCount === 1 ? "project" : "projects"}`,
		}),
		statRailItem(h, {
			eyebrow: "5xx rate",
			value: errorText(totals.errorPercent),
			tone: errorTone(totals.errorPercent),
			spark: buckets.map((row) => row.requests5xx),
			subline: `${formatNumber(totals.requests5xx)} server errors`,
		}),
		statRailItem(h, {
			eyebrow: "Cache hits",
			value: percentText(totals.cacheHitPercent),
			spark: buckets.map((row) => row.cacheHits),
			subline: totals.cacheHitPercent === null ? "no cache lookups" : "of cache lookups",
		}),
		statRailItem(h, {
			eyebrow: "Error logs",
			value: formatNumber(totals.errorLogs),
			tone: totals.errorLogs > 0 ? "warn" : "neutral",
			spark: buckets.map((row) => row.errorLogs),
			subline: "error and fatal records",
		}),
		spend,
	])
}

export const fleetBandLoading = (h: H): Html =>
	statRail(
		h,
		{ columns: 5, isBusy: true },
		Array.from({ length: 5 }, () => statRailItemSkeleton(h)),
	)

interface RowView extends VercelProjectRow {
	readonly sortError: number
	readonly sortCache: number
	readonly sortP95: number
}

// A missing rate or latency sorts below every real one.
const toView = (row: VercelProjectRow): RowView => ({
	...row,
	sortError: row.errorPercent ?? -1,
	sortCache: row.cacheHitPercent ?? -1,
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
		sorted("Project", "name", "w-0 flex-1 min-w-[200px]"),
		columnHead(h, { label: "Production", width: "w-[220px]", hidden: "hidden lg:flex" }),
		sorted("Requests", "requests", "w-[90px]", "right"),
		sorted("5xx", "sortError", "w-[72px]", "right"),
		sorted("Cache hits", "sortCache", "w-[80px]", "right", "hidden md:flex"),
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
			h.div([h.Class("w-0 min-w-[200px] flex-1")], [skeleton(h, "h-4 w-36")]),
			skeleton(h, "hidden h-3 w-[220px] lg:block"),
			skeleton(h, "ml-auto h-3 w-[90px]"),
			skeleton(h, "h-3 w-[72px]"),
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
			h.div(
				[h.Class("flex w-0 min-w-[200px] flex-1 items-baseline gap-2")],
				[
					h.span(
						[
							h.Class(
								"truncate font-mono text-xs font-medium text-foreground transition-colors group-hover:text-primary",
							),
							h.Title(view.name),
						],
						[view.name],
					),
					...(view.framework === null
						? []
						: [
								h.span(
									[h.Class("shrink-0 font-mono text-3xs text-muted-foreground")],
									[view.framework],
								),
							]),
				],
			),
			h.div(
				[h.Class("hidden w-[220px] lg:block")],
				[
					view.production === null
						? h.span([h.Class("text-2xs text-muted-foreground")], ["no production deployment"])
						: deploymentInline(h, view.production, clock),
				],
			),
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
				[h.Class(cn(NUM, "hidden w-[80px] text-foreground/80 md:block"))],
				[percentText(view.cacheHitPercent)],
			),
			h.div(
				[
					h.Class(
						cn(
							NUM,
							"w-[72px]",
							view.p95DurationMs === null ? "text-muted-foreground" : "text-foreground/80",
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
		sortRowsByField(inputs.rows.map(toView), inputs.sort).map((view) =>
			row(h, view, inputs.time, inputs.clock),
		),
	)
