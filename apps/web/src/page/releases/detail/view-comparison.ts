import {
	MIN_COMPARE_SPANS,
	type ReleaseServiceImpact,
	shortReleaseLabel,
} from "../../../components/releases/release-model"
import {
	countLabel,
	EMPTY_VALUE,
	formatErrorRate,
	formatLatency,
	formatNumber,
	formatPercent,
} from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { Html, HtmlBuilder } from "foldkit/html"
import { emptyMessage } from "../../../ui/empty"
import { table, tableBody, tableCell, tableHead, tableHeader, tableRow } from "../../../ui/table"
import { relativeTime } from "../../kit/relative-time"
import { releaseHealthFigure, releaseHref } from "../kit"
import { commitTrigger, type Overlays, releaseHealthPill } from "../overlays-view"
import { sectionCard } from "./view-sections"

// The release comparison and the versions rail.

type Row = Readonly<{
	label: string
	value: number
	baseline: number | undefined
	format: (value: number) => string
	/** Change as a ratio of the baseline; `undefined` when the row has no meaningful change. */
	change: number | undefined
	direction: "lower-is-better" | "higher-is-better" | "neutral"
}>

const changeTone = (row: Row): string => {
	if (row.change === undefined || row.direction === "neutral") return "text-muted-foreground"
	const isBad = row.direction === "lower-is-better" ? row.change > 0 : row.change < 0
	const magnitude = Math.abs(row.change)
	if (!isBad || magnitude < 0.1) return "text-muted-foreground"
	return magnitude >= 1 ? "text-severity-error" : "text-severity-warn"
}

const formatChange = (row: Row): string => {
	if (row.change === undefined) return EMPTY_VALUE
	if (!Number.isFinite(row.change)) return "from 0"
	if (row.direction === "lower-is-better" && row.change >= 1) return `${(1 + row.change).toFixed(1)}×`
	const sign = row.change > 0 ? "+" : row.change < 0 ? "-" : ""
	return `${sign}${formatPercent(Math.abs(row.change))}`
}

const ratioChange = (value: number, baseline: number | undefined): number | undefined =>
	baseline === undefined
		? undefined
		: baseline > 0
			? (value - baseline) / baseline
			: value > 0
				? Number.POSITIVE_INFINITY
				: 0

const rowsOf = (impact: ReleaseServiceImpact): ReadonlyArray<Row> => {
	const { baseline } = impact
	const isComparable =
		baseline !== undefined &&
		impact.spanCount >= MIN_COMPARE_SPANS &&
		baseline.spanCount >= MIN_COMPARE_SPANS
	const latency = (label: string, value: number, before: number | undefined): Row => ({
		label,
		value,
		baseline: before,
		format: formatLatency,
		change: isComparable ? ratioChange(value, before) : undefined,
		direction: "lower-is-better",
	})
	return [
		{
			label: "Requests",
			value: impact.spanCount,
			baseline: baseline?.spanCount,
			format: formatNumber,
			change: undefined,
			direction: "neutral",
		},
		{
			label: "Error rate",
			value: impact.errorRate,
			baseline: baseline?.errorRate,
			format: formatErrorRate,
			change: isComparable ? ratioChange(impact.errorRate, baseline?.errorRate) : undefined,
			direction: "lower-is-better",
		},
		latency("p50", impact.p50LatencyMs, baseline?.p50LatencyMs),
		latency("p95", impact.p95LatencyMs, baseline?.p95LatencyMs),
		latency("p99", impact.p99LatencyMs, baseline?.p99LatencyMs),
		{
			label: "Apdex",
			value: impact.apdexScore,
			baseline: baseline?.apdexScore,
			format: (value) => value.toFixed(2),
			change: isComparable ? ratioChange(impact.apdexScore, baseline?.apdexScore) : undefined,
			direction: "higher-is-better",
		},
	]
}

const mono = <M>(h: HtmlBuilder<M>, sha: string): Html =>
	h.span([h.Class("font-mono normal-case tracking-normal")], [shortReleaseLabel(sha)])

const comparisonTable = <M>(h: HtmlBuilder<M>, impact: ReleaseServiceImpact, baselineSha: string): Html =>
	table(h, { size: "sm" }, [
		tableHeader(h, [
			tableRow(
				h,
				[
					tableHead(h, [], "pl-4"),
					tableHead(h, [mono(h, impact.commitSha)], "text-right"),
					tableHead(h, [mono(h, baselineSha)], "text-right"),
					tableHead(h, ["Change"], "pr-4 text-right"),
				],
				eyebrowVariants(),
			),
		]),
		tableBody(
			h,
			rowsOf(impact).map((row) =>
				tableRow(
					h,
					[
						tableCell(h, [row.label], "pl-4 text-muted-foreground"),
						tableCell(h, [row.format(row.value)], "text-right font-mono tabular-nums"),
						tableCell(
							h,
							[row.baseline === undefined ? EMPTY_VALUE : row.format(row.baseline)],
							"text-right font-mono tabular-nums text-muted-foreground",
						),
						tableCell(
							h,
							[formatChange(row)],
							cn("pr-4 text-right font-mono tabular-nums", changeTone(row)),
						),
					],
					"border-border-subtle",
					[h.Key(row.label)],
				),
			),
		),
	])

const OLDEST_VERSION =
	"This is the oldest version of the service in the window, so there is nothing to compare against. Widen the time range to include the version it replaced."

/** `ReleaseComparison`: this version against the one it replaced on the same service. */
export const releaseComparison = <M>(
	h: HtmlBuilder<M>,
	impact: ReleaseServiceImpact,
	overlays: Overlays<M>,
): Html => {
	const { baseline } = impact
	const isComparable =
		baseline !== undefined &&
		impact.spanCount >= MIN_COMPARE_SPANS &&
		baseline.spanCount >= MIN_COMPARE_SPANS
	const action =
		baseline === undefined
			? h.span([h.Class("text-2xs text-foreground-subtle")], ["no previous version"])
			: commitTrigger(
					h,
					overlays,
					"release-replaced",
					baseline.commitSha,
					"font-mono text-2xs text-muted-foreground",
					["replaced ", shortReleaseLabel(baseline.commitSha)],
				)
	return sectionCard(h, { title: "This version vs. the previous one", action }, [
		baseline === undefined
			? emptyMessage(h, {}, [OLDEST_VERSION])
			: comparisonTable(h, impact, baseline.commitSha),
		...(baseline !== undefined && !isComparable
			? [
					h.div(
						[h.Class("border-t px-4 py-2 text-2xs text-foreground-subtle")],
						[`Changes are withheld below ${MIN_COMPARE_SPANS} requests on either side.`],
					),
				]
			: []),
	])
}

type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>
export type RailInput<M> = Readonly<{
	overlays: Overlays<M>
	impacts: ReadonlyArray<ReleaseServiceImpact>
	currentSha: string
	serviceName: string
	environments: ReadonlyArray<string> | undefined
	timeSearch: TimeSearch
	nowMs: number
	timeZone: string
}>

/** `ReleaseVersionsRail`: every version of the service in the window, newest first. */
export const releaseVersionsRail = <M>(h: HtmlBuilder<M>, input: RailInput<M>): Html => {
	const sorted = input.impacts.toSorted((a, b) =>
		a.firstSeen < b.firstSeen ? 1 : a.firstSeen > b.firstSeen ? -1 : 0,
	)
	return sectionCard(
		h,
		{
			title: "Versions in window",
			action: h.span(
				[h.Class("text-2xs text-foreground-subtle")],
				[countLabel(sorted.length, "version")],
			),
		},
		[
			h.div(
				[h.Class("max-h-80 space-y-px overflow-y-auto p-2")],
				sorted.map((version) => versionLink(h, input, version)),
			),
		],
	)
}

const versionLink = <M>(h: HtmlBuilder<M>, input: RailInput<M>, version: ReleaseServiceImpact): Html =>
	h.a(
		[
			h.Key(`${version.commitSha}:${version.environment}`),
			h.Href(
				releaseHref(version.commitSha, {
					service: input.serviceName,
					environments:
						input.environments ?? (version.environment ? [version.environment] : undefined),
					...input.timeSearch,
				}),
			),
			h.Class(
				cn(
					"flex items-center gap-2.5 rounded-sm px-2 py-1.5 text-xs hover:bg-surface-sunken active:bg-surface-sunken focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
					version.commitSha === input.currentSha && "bg-surface-strong",
				),
			),
		],
		[
			commitTrigger(h, input.overlays, "release-rail", version.commitSha, "font-mono text-foreground", [
				shortReleaseLabel(version.commitSha),
			]),
			...(version.health === "healthy"
				? []
				: [
						releaseHealthPill(
							h,
							input.overlays,
							`release-rail-pill-${version.commitSha.replace(/[^A-Za-z0-9_-]/g, "_")}`,
							version.health,
							releaseHealthFigure(version),
						),
					]),
			h.span(
				[h.Class("ml-auto shrink-0 font-mono tabular-nums text-muted-foreground")],
				[formatNumber(version.spanCount)],
			),
			relativeTime(h, {
				value: version.firstSeen,
				nowMs: input.nowMs,
				timeZone: input.timeZone,
				variant: "orDate",
				tooltip: "title",
				className: "w-16 shrink-0 text-right font-mono tabular-nums text-foreground-subtle",
			}),
		],
	)
