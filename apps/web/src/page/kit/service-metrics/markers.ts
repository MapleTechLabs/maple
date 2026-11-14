import {
	buildCommitMarkers,
	type CommitMarker,
	type LabelGroup,
	layoutMarkerLabels,
	type PositionedMarker,
	shouldRenderLabels,
} from "./marker-layout"
import { parseBucketMs } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { PlotGeometry } from "@maple/views/charts/chart"
import type { CommitData, Release } from "./points"
import { Array as Arr, Order } from "effect"
import { firstLine, isResolvableSha } from "../commit-card"
import { MARKER_CARD_COMMITS } from "./marker-card"

// Commit markers over a chart: the markers, their commit labels and their geometry (./marker-layout.ts).

/** The markers over the chart buckets, each relabelled with its commit subject once that resolved. */
export const commitMarkers = (
	releases: ReadonlyArray<Release>,
	chartBuckets: ReadonlyArray<string>,
	commits: Readonly<Record<string, CommitData>>,
): ReadonlyArray<CommitMarker> =>
	Arr.map(buildCommitMarkers(releases, chartBuckets), (marker) => {
		const sha = marker.commits[0]?.sha
		const commit = sha === undefined || !isResolvableSha(sha) ? undefined : commits[sha]
		const label =
			commit === undefined || !AsyncData.isSuccess(commit) ? "" : firstLine(commit.data.message)
		return label === "" ? marker : { ...marker, label }
	})

/** Every sha a marker label or its hover card resolves (the card lists up to `MARKER_CARD_COMMITS`). */
export const markerShas = (markers: ReadonlyArray<CommitMarker>): ReadonlyArray<string> =>
	Arr.flatMap(markers, (marker) =>
		Arr.flatMap(marker.commits.slice(0, MARKER_CARD_COMMITS), (commit) =>
			isResolvableSha(commit.sha) ? [commit.sha] : [],
		),
	)

const EDGE_EPSILON = 0.5

/** `markerPixel` over the time scale's affine map; a bucket off the plot is not drawn. */
const markerPixel = (bucket: string, plot: PlotGeometry): number | null => {
	const ms = parseBucketMs(bucket)
	if (ms === null) return null
	const span = plot.domainEndMs - plot.domainStartMs
	const x =
		span === 0
			? plot.rangeStart
			: plot.rangeStart + ((ms - plot.domainStartMs) / span) * (plot.rangeEnd - plot.rangeStart)
	if (!Number.isFinite(x)) return null
	return x < plot.x - EDGE_EPSILON || x > plot.x + plot.width + EDGE_EPSILON ? null : x
}

export type MarkerLayout = Readonly<{ groups: ReadonlyArray<LabelGroup>; labeled: boolean }>

/** The groups the markers overlay draws on one chart: labelled, or dashes only when dense. */
export const markerLayout = (markers: ReadonlyArray<CommitMarker>, plot: PlotGeometry): MarkerLayout => {
	const plotLeft = plot.x
	const plotRight = plot.x + plot.width
	const positioned: Array<PositionedMarker> = Arr.sort(
		Arr.flatMap(markers, (marker) => {
			const x = markerPixel(marker.bucket, plot)
			return x === null ? [] : [{ marker, x }]
		}),
		Order.mapInput(Order.Number, (entry: PositionedMarker) => entry.x),
	)
	if (!shouldRenderLabels(positioned, plotLeft, plotRight)) {
		return {
			groups: Arr.map(positioned, (entry): LabelGroup => ({
				key: entry.marker.bucket,
				dashXs: [entry.x],
				label: entry.marker.label,
				commits: [...entry.marker.commits],
				boxLeft: entry.x,
				boxWidth: 0,
			})),
			labeled: false,
		}
	}
	return { groups: layoutMarkerLabels(positioned, plotLeft, plotRight), labeled: true }
}
