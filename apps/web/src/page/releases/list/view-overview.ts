import { countLabel, formatPercent, pluralize } from "@maple/ui/lib/format"
import { formatRelativeTimeOrDate, toEpochMs } from "@maple/ui/lib/time-format"
import { cn } from "@maple/ui/lib/utils"
import {
	RELEASE_HEALTH_ORDER,
	ROLLOUT_COMPLETE_SHARE,
	shortReleaseLabel,
	type LiveVersion,
	type ReleaseHealth,
	type ReleaseServiceImpact,
} from "../../../components/releases/release-model"
import { formatDateInTimezone, formatTimestampInTimezone } from "@maple/web-data/lib/timezone-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import { eyebrow } from "../../../ui/eyebrow"
import { panel, panelHeader } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { truncatedText } from "../../../ui/truncated-text"
import { serviceDot } from "../../../ui/values"
import { RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL, releaseHealthFigure, releaseHref } from "../kit"
import { MeasureReleasesTrack } from "./command"
import type { Message } from "./message"

// `ReleasesLiveNow` and `ReleasesTimeline` (apps/web/src/components/releases/).

type H = HtmlBuilder<Message>
export type TimeSearch = Readonly<{ startTime?: string; endTime?: string; timePreset?: string }>

const MAX_SHOWN = 16

export const liveNow = (
	h: H,
	live: ReadonlyArray<LiveVersion>,
	timeSearch: TimeSearch,
	environments: ReadonlyArray<string> | undefined,
): Html | null => {
	if (live.length === 0) return null
	const shown = live.slice(0, MAX_SHOWN)
	const hidden = live.length - shown.length
	const behind = live.filter((version) => version.behind > 0).length
	return panel(h, { className: "gap-2 px-3 py-2.5" }, [
		h.div(
			[h.Class("flex items-baseline justify-between gap-3")],
			[
				eyebrow(h, {}, ["Live now"]),
				behind > 0
					? h.span(
							[h.Class("text-2xs text-severity-warn")],
							[`${countLabel(behind, "service")} not on the latest release`],
						)
					: h.span(
							[h.Class("text-2xs text-muted-foreground/70")],
							["Every service is on its latest release"],
						),
			],
		),
		h.div(
			[h.Class("flex flex-wrap gap-1.5")],
			[
				...shown.map((version) =>
					linkButton(
						h,
						{
							variant: "outline",
							size: "xs",
							className: cn(
								"font-normal",
								version.behind > 0 && "border-severity-warn/40 bg-severity-warn/5",
							),
							href: releaseHref(version.commitSha, {
								...timeSearch,
								environments,
								service: version.serviceName,
							}),
							attributes: [
								h.Key(version.serviceName),
								...(version.behind > 0
									? [
											h.Title(
												`${version.behind} newer ${pluralize(version.behind, "release")} reached the services ${version.serviceName} usually ships with, but not ${version.serviceName}`,
											),
										]
									: []),
							],
						},
						[
							serviceDot(h, { serviceName: version.serviceName }),
							h.span([], [version.serviceName]),
							h.span(
								[h.Class("font-mono text-2xs text-muted-foreground")],
								[shortReleaseLabel(version.commitSha)],
							),
							...(version.share < ROLLOUT_COMPLETE_SHARE
								? [
										h.span(
											[h.Class("font-mono text-3xs tabular-nums text-primary")],
											[formatPercent(version.share)],
										),
									]
								: []),
							...(version.behind > 0
								? [
										h.span(
											[h.Class("font-mono text-3xs tabular-nums text-severity-warn")],
											[String(version.behind), " behind"],
										),
									]
								: []),
						],
					),
				),
				...(hidden > 0
					? [
							h.span(
								[h.Class("self-center px-1 text-2xs text-muted-foreground/70")],
								[`+${hidden}`],
							),
						]
					: []),
			],
		),
	])
}

// The releases timeline's layout constants.
const MAX_LANES = 12
const MERGE_PX = 18
const FALLBACK_MERGE_RATIO = 0.016
const TRACK_INSET_PX = 8

interface Marker {
	readonly ratio: number
	readonly members: ReadonlyArray<ReleaseServiceImpact>
	readonly health: ReleaseHealth
}

const buildLanes = (impacts: ReadonlyArray<ReleaseServiceImpact>) => {
	const byService = new Map<
		string,
		{ serviceName: string; spanCount: number; dots: Array<ReleaseServiceImpact> }
	>()
	impacts.forEach((impact) => {
		const lane = byService.get(impact.serviceName)
		if (lane === undefined)
			byService.set(impact.serviceName, {
				serviceName: impact.serviceName,
				spanCount: impact.spanCount,
				dots: [impact],
			})
		else
			byService.set(impact.serviceName, {
				...lane,
				spanCount: lane.spanCount + impact.spanCount,
				dots: [...lane.dots, impact],
			})
	})
	return [...byService.values()].toSorted(
		(a, b) => b.spanCount - a.spanCount || a.serviceName.localeCompare(b.serviceName),
	)
}

const worstHealth = (members: ReadonlyArray<ReleaseServiceImpact>): ReleaseHealth =>
	RELEASE_HEALTH_ORDER.find((band) => members.some((member) => member.health === band)) ?? "healthy"

/** `clusterMarkers`: greedy left-to-right, a dot joins the open marker within `mergeRatio`. */
const clusterMarkers = (
	dots: ReadonlyArray<ReleaseServiceImpact>,
	startMs: number,
	endMs: number,
	mergeRatio: number,
): ReadonlyArray<Marker> => {
	const span = Math.max(1, endMs - startMs)
	const placed = dots
		.map((dot) => ({ dot, ratio: Math.min(1, Math.max(0, (toEpochMs(dot.firstSeen) - startMs) / span)) }))
		.toSorted((a, b) => a.ratio - b.ratio)
	const groups = placed.reduce<
		ReadonlyArray<{ anchor: number; items: ReadonlyArray<(typeof placed)[number]> }>
	>((acc, item) => {
		const open = acc[acc.length - 1]
		return open !== undefined && item.ratio - open.anchor < mergeRatio
			? [...acc.slice(0, -1), { ...open, items: [...open.items, item] }]
			: [...acc, { anchor: item.ratio, items: [item] }]
	}, [])
	return groups.map((group) => {
		const members = group.items.map((item) => item.dot).toReversed()
		return {
			ratio: group.items.reduce((sum, item) => sum + item.ratio, 0) / group.items.length,
			members,
			health: worstHealth(members),
		}
	})
}

const axisLabels = (startMs: number, endMs: number, timeZone: string): ReadonlyArray<string> => {
	const span = endMs - startMs
	const showTime = span <= 3 * 86_400_000
	return [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
		const date = new Date(startMs + span * ratio)
		return showTime
			? formatTimestampInTimezone(date, { timeZone, style: "range" })
			: formatDateInTimezone(date, { timeZone, withYear: false })
	})
}

const markerTitle = (marker: Marker, nowMs: number, timeZone: string): string => {
	const newest = marker.members[0]
	if (newest === undefined) return ""
	const ago = (iso: string) => formatRelativeTimeOrDate(iso, nowMs, timeZone)
	if (marker.members.length === 1) {
		const figure = releaseHealthFigure(newest)
		return `${shortReleaseLabel(newest.commitSha)} · ${ago(newest.firstSeen)}${figure ? ` · ${figure}` : ""}`
	}
	const oldest = marker.members[marker.members.length - 1] ?? newest
	const listed = marker.members
		.slice(0, 6)
		.map((member) => shortReleaseLabel(member.commitSha))
		.join(", ")
	const more = marker.members.length > 6 ? `, +${marker.members.length - 6} more` : ""
	return `${countLabel(marker.members.length, "deploy")} · ${ago(oldest.firstSeen)} → ${ago(newest.firstSeen)}\n${listed}${more}`
}

export type TimelineInput = Readonly<{
	impacts: ReadonlyArray<ReleaseServiceImpact>
	startTime: string
	endTime: string
	timeSearch: TimeSearch
	environments: ReadonlyArray<string> | undefined
	/** The first lane's measured track width (0 before the measure). */
	trackWidth: number
	nowMs: number
	timeZone: string
}>

/** `ReleasesTimeline`: one lane per service, one marker per deploy (close ones merged). */
export const releasesTimeline = (h: H, input: TimelineInput): Html => {
	const startMs = toEpochMs(input.startTime)
	const endMs = toEpochMs(input.endTime)
	const usable = input.trackWidth - TRACK_INSET_PX * 2
	const mergeRatio = usable > MERGE_PX ? MERGE_PX / usable : FALLBACK_MERGE_RATIO
	const lanes = buildLanes(input.impacts).map((lane) => ({
		...lane,
		markers: clusterMarkers(lane.dots, startMs, endMs, mergeRatio),
	}))
	const visible = lanes.slice(0, MAX_LANES)
	const hidden = lanes.length - visible.length
	const twoColumns = "grid-cols-[minmax(0,160px)_1fr]"
	return panel(h, { className: "overflow-visible" }, [
		panelHeader(h, {
			title: "Deploys over time",
			divided: false,
			className: "px-3 pt-2.5",
			action: h.div(
				[h.Class("flex items-center gap-3 text-3xs text-muted-foreground")],
				RELEASE_HEALTH_ORDER.map((band) =>
					h.span(
						[h.Class("inline-flex items-center gap-1")],
						[
							statusDot(h, {
								tone: "custom",
								size: "lg",
								className: RELEASE_HEALTH_DOT_CLASS[band],
							}),
							RELEASE_HEALTH_LABEL[band],
						],
					),
				),
			),
		}),
		h.div(
			[h.Class("px-3 pb-2 pt-1")],
			[
				...visible.map((lane, laneIndex) =>
					h.div(
						[h.Key(lane.serviceName), h.Class(`grid h-8 ${twoColumns} items-center gap-3`)],
						[
							h.span(
								[h.Class("flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground")],
								[
									serviceDot(h, { serviceName: lane.serviceName }),
									truncatedText(h, { text: lane.serviceName }),
								],
							),
							h.div(
								[
									h.Class("relative h-full border-b border-dashed border-border/60"),
									...(laneIndex === 0 ? [h.OnMount(MeasureReleasesTrack())] : []),
								],
								lane.markers.flatMap((marker) => {
									const newest = marker.members[0]
									if (newest === undefined) return []
									const count = marker.members.length
									return [
										h.a(
											[
												h.Key(
													`${newest.commitSha}:${newest.environment}:${marker.ratio}`,
												),
												h.Href(
													releaseHref(newest.commitSha, {
														service: newest.serviceName,
														environments:
															input.environments ??
															(newest.environment
																? [newest.environment]
																: undefined),
														...input.timeSearch,
													}),
												),
												h.Title(markerTitle(marker, input.nowMs, input.timeZone)),
												h.AriaLabel(
													`${lane.serviceName}: ${count === 1 ? shortReleaseLabel(newest.commitSha) : `${count} deploys`}`,
												),
												h.Class(
													"group absolute top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center focus-visible:outline-none",
												),
												h.Style({
													left: `calc(${TRACK_INSET_PX}px + ${marker.ratio} * (100% - ${TRACK_INSET_PX * 2}px))`,
												}),
											],
											[
												h.span([
													h.Class(
														cn(
															"block size-3 rounded-full ring-2 ring-card transition-transform group-hover:scale-125 group-focus-visible:ring-ring",
															RELEASE_HEALTH_DOT_CLASS[marker.health],
														),
													),
												]),
												...(count > 1
													? [
															h.span(
																[
																	h.Class(
																		"absolute left-full ml-0.5 rounded-sm bg-card px-0.5 font-mono text-4xs leading-none tabular-nums text-muted-foreground",
																	),
																],
																[String(count)],
															),
														]
													: []),
											],
										),
									]
								}),
							),
						],
					),
				),
				...(hidden > 0
					? [
							h.div(
								[h.Class(`grid ${twoColumns} gap-3 py-1 text-3xs text-muted-foreground/70`)],
								[h.span([], [`+${hidden} more ${pluralize(hidden, "service")}`])],
							),
						]
					: []),
				h.div(
					[h.Class(`grid ${twoColumns} gap-3 pt-1.5`)],
					[
						h.span([]),
						h.div(
							[
								h.Class(
									"flex justify-between font-mono text-3xs tabular-nums text-muted-foreground/70",
								),
								h.Style({
									"padding-left": `${TRACK_INSET_PX}px`,
									"padding-right": `${TRACK_INSET_PX}px`,
								}),
							],
							axisLabels(startMs, endMs, input.timeZone).map((label) => h.span([], [label])),
						),
					],
				),
			],
		),
	])
}
