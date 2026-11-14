import { parseBucketMs } from "@maple/ui/lib/format"
import { Array as Arr, Record as Rec, String as Str } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { FixedMetricRow } from "@maple/views/charts/chart-spec"
import { MountLinkedZoom } from "@maple/views/charts/linked-cursor"
import { ResolveThemeColors } from "@maple/views/charts/theme-colors"
import { isReady, Message, type Model } from "./chart-bench"
import { CHART_TOKENS, metricsGridOf } from "../../page/kit/service-metrics/grid"
import { commitMarkers } from "../../page/kit/service-metrics/markers"
import type { CommitData, Release } from "../../page/kit/service-metrics/points"

// `/lab/bench/service-detail` and
// `/lab/bench/overview`): the service-detail chart grid over synthetic rows. A drag zooms the rows.

const BUCKET_COUNT = 145
const BUCKET_MS = 5 * 60 * 1000
const END_TIME_MS = Date.UTC(2026, 6, 17, 18, 30)

const bucketAt = (index: number) =>
	new Date(END_TIME_MS - (BUCKET_COUNT - 1 - index) * BUCKET_MS).toISOString()

export const SERVICE_DETAIL_POINTS: ReadonlyArray<FixedMetricRow> = Arr.makeBy(BUCKET_COUNT, (index) => {
	const phase = (index / (BUCKET_COUNT - 1)) * Math.PI * 6
	const traffic = 1_250 + Math.sin(phase) * 410 + Math.cos(phase * 0.37) * 190
	const errorRate = 0.18 + Math.max(0, Math.sin(phase * 0.73)) * 0.42
	const p50LatencyMs = 320 + Math.sin(phase * 0.63) * 85
	return {
		bucket: bucketAt(index),
		p50LatencyMs,
		p95LatencyMs: p50LatencyMs * 1.8,
		p99LatencyMs: p50LatencyMs * 2.75,
		throughput: traffic * (BUCKET_MS / 1000),
		tracedThroughput: traffic * 0.14 * (BUCKET_MS / 1000),
		hasSampling: true,
		errorRate,
		apdexScore: Math.max(0.72, 0.97 - errorRate * 0.12 - Math.sin(phase * 0.41) * 0.025),
	}
})

const rowsIn = (zoom: Model["zoom"]): ReadonlyArray<FixedMetricRow> =>
	zoom === null
		? SERVICE_DETAIL_POINTS
		: Arr.filter(SERVICE_DETAIL_POINTS, (row) => {
				const at = parseBucketMs(row.bucket)
				return at !== null && at >= zoom.startMs && at <= zoom.endMs
			})

const sha = (seed: string) => Str.repeat(40 / seed.length)(seed)

/** Synthetic deploys: one already running, a lone deploy, a group of three and a late one. */
const DEPLOYS: ReadonlyArray<Readonly<{ at: number; sha: string; message: string; author: string }>> = [
	{ at: 0, sha: sha("a0"), message: "chore: baseline", author: "baseline" },
	{ at: 38, sha: sha("b1"), message: "feat(security): audit every token exchange", author: "dana" },
	{
		at: 82,
		sha: sha("c2"),
		message: "fix(ingest): keep three request costs bounded per request",
		author: "lee",
	},
	{ at: 82, sha: sha("d3"), message: "perf(query): cache the service map rollup", author: "kai" },
	{ at: 82, sha: sha("e4"), message: "refactor(api): one error shape for every route", author: "sam" },
	{ at: 118, sha: sha("f5"), message: "feat(web): keyboard row navigation on lists", author: "dana" },
]

const RELEASES: ReadonlyArray<Release> = Arr.flatMap(DEPLOYS, (deploy) =>
	Arr.makeBy(BUCKET_COUNT - deploy.at, (offset) => ({
		bucket: bucketAt(deploy.at + offset),
		commitSha: deploy.sha,
		count: 100,
		errorCount: 0,
	})),
)

const COMMITS: Readonly<Record<string, CommitData>> = Rec.fromEntries(
	Arr.map(DEPLOYS, (deploy, index) => [
		deploy.sha,
		AsyncData.Success({
			data: {
				sha: deploy.sha,
				message: deploy.message,
				authorName: null,
				authorLogin: deploy.author,
				authorAvatarUrl: null,
				committedAt: END_TIME_MS - (BUCKET_COUNT - deploy.at) * BUCKET_MS - index * 60_000,
			},
		}),
	]),
)

/** The bench page: `MetricsGrid` with `yAxisWidth={72}` under a padded full-height frame. */
export const view = (model: Model, h: HtmlBuilder<Message>): Html => {
	const rows = rowsIn(model.zoom)
	return viewOf(model, h, rows, [])
}

/** The bench with deploy markers, a group of three among them; hovering one opens its card. */
export const viewWithMarkers = (model: Model, h: HtmlBuilder<Message>): Html => {
	const rows = rowsIn(model.zoom)
	return viewOf(
		model,
		h,
		rows,
		commitMarkers(
			RELEASES,
			Arr.map(rows, (row) => String(row.bucket)),
			COMMITS,
		),
	)
}

const viewOf = (
	model: Model,
	h: HtmlBuilder<Message>,
	rows: ReadonlyArray<FixedMetricRow>,
	markers: ReturnType<typeof commitMarkers>,
): Html =>
	h.div(
		[
			h.DataAttribute("testid", "service-detail-chart-bench"),
			h.Class("min-h-screen bg-background p-6 text-foreground"),
			h.OnMount(ResolveThemeColors({ tokens: CHART_TOKENS })),
		],
		[
			metricsGridOf(
				h,
				{
					charts: model.charts,
					rows,
					markers,
					markerCard: {
						model: model.markerCard,
						toParent: (message) => Message.GotMarkerCardMessage({ message }),
						commits: COMMITS,
						clock: { nowMs: model.nowMs, timeZone: model.timeZone },
					},
					toChartMessage: (chartId, message) => Message.GotChartMessage({ chartId, message }),
					linkedCursorMount: MountLinkedZoom({ timeZone: model.timeZone }),
				},
				{
					isLoading: !isReady(model),
					isWaiting: false,
					context:
						model.themeColors === null
							? null
							: { theme: model.themeColors, timeZone: model.timeZone, nowMs: model.nowMs },
				},
			),
		],
	)
