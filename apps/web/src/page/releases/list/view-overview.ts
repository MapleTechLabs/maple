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
import { linkButton } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { statusDot } from "@maple/views/ui/status-dot"
import { truncatedText } from "@maple/views/ui/truncated-text"
import { serviceDot } from "@maple/views/ui/values"
import { RELEASE_HEALTH_DOT_CLASS, RELEASE_HEALTH_LABEL, releaseHealthFigure, releaseHref } from "../kit"
import { MeasureReleasesTrack } from "./command"
import type { Message } from "./message"
import { typography, typographyClass } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, String as Str, Option, Order } from "effect"

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
	const behind = Arr.filter(live, (version) => version.behind > 0).length
	return panel(h, { className: "gap-2 px-3 py-2.5" }, [
		hstack(h, { gap: "3", align: "baseline", justify: "between" }, [
			eyebrow(h, {}, ["Live now"]),
			behind > 0
				? typography(h, { size: "2xs", tone: "warning" }, [
						`${countLabel(behind, "service")} not on the latest release`,
					])
				: typography(h, { size: "2xs", tone: "subtle" }, ["Every service is on its latest release"]),
		]),
		hstack(h, { gap: "1.5", align: "stretch", wrap: true }, [
			...Arr.map(shown, (version) =>
				linkButton(
					h,
					{
						variant: "outline",
						size: "xs",
						className: cn(
							"font-normal",
							version.behind > 0 && "border-severity-warn-a4 bg-severity-warn-a1",
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
						typography(h, { size: "2xs", tone: "muted", mono: true }, [
							shortReleaseLabel(version.commitSha),
						]),
						...(version.share < ROLLOUT_COMPLETE_SHARE
							? [
									typography(
										h,
										{ size: "3xs", tone: "primary", mono: true, numeric: true },
										[formatPercent(version.share)],
									),
								]
							: []),
						...(version.behind > 0
							? [
									typography(
										h,
										{ size: "3xs", tone: "warning", mono: true, numeric: true },
										[String(version.behind), " behind"],
									),
								]
							: []),
					],
				),
			),
			...(hidden > 0
				? [h.span([h.Class("self-center px-1 text-2xs text-foreground-subtle")], [`+${hidden}`])]
				: []),
		]),
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

type Lane = { serviceName: string; spanCount: number; dots: Array<ReleaseServiceImpact> }

const buildLanes = (impacts: ReadonlyArray<ReleaseServiceImpact>) => {
	const byService = new Map<string, Lane>()
	Arr.forEach(impacts, (impact) => {
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
	return Arr.sort(
		[...byService.values()],
		Order.combine(
			Order.flip(Order.mapInput(Order.Number, (lane: Lane) => lane.spanCount)),
			(a: Lane, b: Lane) => Str.localeCompare(b.serviceName)(a.serviceName),
		),
	)
}

const worstHealth = (members: ReadonlyArray<ReleaseServiceImpact>): ReleaseHealth =>
	Option.getOrElse(
		Arr.findFirst(RELEASE_HEALTH_ORDER, (band) => Arr.some(members, (member) => member.health === band)),
		(): ReleaseHealth => "healthy",
	)

/** `clusterMarkers`: greedy left-to-right, a dot joins the open marker within `mergeRatio`. */
const clusterMarkers = (
	dots: ReadonlyArray<ReleaseServiceImpact>,
	startMs: number,
	endMs: number,
	mergeRatio: number,
): ReadonlyArray<Marker> => {
	const span = Math.max(1, endMs - startMs)
	const placed = Arr.sort(
		Arr.map(dots, (dot) => ({
			dot,
			ratio: Math.min(1, Math.max(0, (toEpochMs(dot.firstSeen) - startMs) / span)),
		})),
		Order.mapInput(Order.Number, (item: { readonly ratio: number }) => item.ratio),
	)
	const groups = Arr.reduce<
		(typeof placed)[number],
		ReadonlyArray<{ anchor: number; items: ReadonlyArray<(typeof placed)[number]> }>
	>(placed, [], (acc, item) => {
		const open = acc[acc.length - 1]
		return open !== undefined && item.ratio - open.anchor < mergeRatio
			? [...acc.slice(0, -1), { ...open, items: [...open.items, item] }]
			: [...acc, { anchor: item.ratio, items: [item] }]
	})
	return Arr.map(groups, (group) => {
		const members = Arr.reverse(Arr.map(group.items, (item) => item.dot))
		return {
			ratio: Arr.reduce(group.items, 0, (sum, item) => sum + item.ratio) / group.items.length,
			members,
			health: worstHealth(members),
		}
	})
}

const axisLabels = (startMs: number, endMs: number, timeZone: string): ReadonlyArray<string> => {
	const span = endMs - startMs
	const showTime = span <= 3 * 86_400_000
	return Arr.map([0, 0.25, 0.5, 0.75, 1], (ratio) => {
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
	const listed = Arr.join(
		Arr.map(marker.members.slice(0, 6), (member) => shortReleaseLabel(member.commitSha)),
		", ",
	)
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
	const lanes = Arr.map(buildLanes(input.impacts), (lane) => ({
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
			action: hstack(
				h,
				{ gap: "3", align: "center", className: typographyClass({ size: "3xs", tone: "muted" }) },
				Arr.map(RELEASE_HEALTH_ORDER, (band) =>
					hstack(h, { gap: "1", inline: true, as: "span" }, [
						statusDot(h, {
							tone: "custom",
							size: "lg",
							className: RELEASE_HEALTH_DOT_CLASS[band],
						}),
						RELEASE_HEALTH_LABEL[band],
					]),
				),
			),
		}),
		h.div(
			[h.Class("px-3 pb-2 pt-1")],
			[
				...Arr.map(visible, (lane, laneIndex) =>
					h.div(
						[h.Key(lane.serviceName), h.Class(`grid h-8 ${twoColumns} items-center gap-3`)],
						[
							hstack(
								h,
								{
									gap: "1.5",
									align: "center",
									shrink: true,
									as: "span",
									className: typographyClass({ size: "2xs", tone: "muted" }),
								},
								[
									serviceDot(h, { serviceName: lane.serviceName }),
									truncatedText(h, { text: lane.serviceName }),
								],
							),
							h.div(
								[
									h.Class("relative h-full border-b border-dashed border-border-subtle"),
									...(laneIndex === 0 ? [h.OnMount(MeasureReleasesTrack())] : []),
								],
								Arr.flatMap(lane.markers, (marker) => {
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
								[h.Class(`grid ${twoColumns} gap-3 py-1 text-3xs text-foreground-subtle`)],
								[h.span([], [`+${hidden} more ${pluralize(hidden, "service")}`])],
							),
						]
					: []),
				h.div(
					[h.Class(`grid ${twoColumns} gap-3 pt-1.5`)],
					[
						h.span([]),
						hstack(
							h,
							{
								align: "stretch",
								justify: "between",
								className: "font-mono text-3xs tabular-nums text-foreground-subtle",
								attributes: [
									h.Style({
										"padding-left": `${TRACK_INSET_PX}px`,
										"padding-right": `${TRACK_INSET_PX}px`,
									}),
								],
							},
							Arr.map(axisLabels(startMs, endMs, input.timeZone), (label) =>
								h.span([], [label]),
							),
						),
					],
				),
			],
		),
	])
}
