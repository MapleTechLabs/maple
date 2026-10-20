import {
	buildCommitMarkers,
	type CommitMarker,
	type LabelGroup,
	layoutMarkerLabels,
	type PositionedMarker,
	shouldRenderLabels,
} from "../../../components/vcs/commit-markers/marker-layout"
import { parseBucketMs } from "@maple/ui/lib/format"
import { AsyncData } from "foldkit"
import type { PlotGeometry } from "../../../charts/chart"
import { firstLine, isResolvableSha } from "./derive-panels"
import type { CommitData, Release } from "./model"

// `useCommitMarkers` and `CommitMarkersOverlay`'s geometry (components/vcs/commit-markers/).

/** The markers over the chart buckets, each relabelled with its commit subject once that resolved. */
export const commitMarkers = (
	releases: ReadonlyArray<Release>,
	chartBuckets: ReadonlyArray<string>,
	commits: Readonly<Record<string, CommitData>>,
): ReadonlyArray<CommitMarker> =>
	buildCommitMarkers(releases, chartBuckets).map((marker) => {
		const sha = marker.commits[0]?.sha
		const commit = sha === undefined || !isResolvableSha(sha) ? undefined : commits[sha]
		const label =
			commit === undefined || !AsyncData.isSuccess(commit) ? "" : firstLine(commit.data.message)
		return label === "" ? marker : { ...marker, label }
	})

/** Every sha a marker label resolves (`commitQueryAtom` per representative commit). */
export const markerShas = (markers: ReadonlyArray<CommitMarker>): ReadonlyArray<string> =>
	markers.flatMap((marker) => {
		const sha = marker.commits[0]?.sha
		return sha !== undefined && isResolvableSha(sha) ? [sha] : []
	})

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

/** The groups `CommitMarkersOverlay` draws on one chart: labelled, or dashes only when dense. */
export const markerLayout = (markers: ReadonlyArray<CommitMarker>, plot: PlotGeometry): MarkerLayout => {
	const plotLeft = plot.x
	const plotRight = plot.x + plot.width
	const positioned: Array<PositionedMarker> = markers
		.flatMap((marker) => {
			const x = markerPixel(marker.bucket, plot)
			return x === null ? [] : [{ marker, x }]
		})
		.toSorted((a, b) => a.x - b.x)
	if (!shouldRenderLabels(positioned, plotLeft, plotRight)) {
		return {
			groups: positioned.map((entry): LabelGroup => ({
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
