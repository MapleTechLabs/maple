import { Array as Arr, Option, Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { shiftTimeline, type TimelineBar, type TimelineRow } from "@maple/views/ui/shift-timeline"
import { hstack, vstack } from "@maple/views/ui/stack"
import { heading } from "@maple/views/ui/heading"
import { typography } from "@maple/views/ui/typography"
import { formatShiftEdge } from "./oncall-schedules"
import { gapRangeText, gapSummary, type Interval } from "./schedule-coverage"

// The coverage timeline both the schedule editor (from the draft) and the detail page (from the
// server's shifts) draw: a lane per layer, the final lane with its "No one" gaps, and the controls.

export const RangeDays = Schema.Literals(["7", "14", "28"])
export type RangeDays = typeof RangeDays.Type
export const DEFAULT_RANGE_DAYS: RangeDays = "14"

const RANGE_OPTIONS: ReadonlyArray<Readonly<{ value: RangeDays; label: string }>> = [
	{ value: "7", label: "1 week" },
	{ value: "14", label: "2 weeks" },
	{ value: "28", label: "4 weeks" },
]

/** The summary links this many gaps; the rest are on the timeline. */
const MAX_GAP_LINKS = 6

/** The element id of a gap's bar, so its summary link can scroll to and focus it. */
export const gapBarId = (scope: string, index: number): string => `${scope}-gap-${index}`

export type PreviewShift = Readonly<{ userId: string; startMs: number; endMs: number; isOverride: boolean }>

export type PreviewLane = Readonly<{
	key: string
	label: string
	detail: string
	/** None while the layer cannot be drawn; `emptyText` says why. */
	shifts: Option.Option<ReadonlyArray<PreviewShift>>
	emptyText: string
}>

export type CoveragePreviewOptions<M> = Readonly<{
	/** Prefixes the gap bars' ids, unique on the page. */
	scope: string
	title: string
	timeZone: string
	fromMs: number
	toMs: number
	nowMs: number
	weekOffset: number
	rangeDays: RangeDays
	lanes: ReadonlyArray<PreviewLane>
	final: ReadonlyArray<PreviewShift>
	gaps: ReadonlyArray<Interval>
	nameOf: (userId: string) => string
	onPrevious: M
	onNext: M
	onToday: M
	onRange: (days: RangeDays) => M
	onFocusGap: (index: number) => M
	/** A final shift's bar action (the detail page's "cover with an override"). */
	onFinalShift?: (shift: PreviewShift) => Option.Option<M>
	/** Plain-language notes over the timeline. */
	warnings?: ReadonlyArray<string>
	/** A line under the header, after the zone note. */
	note?: string
	/** Drawn in place of the summary and timeline while their data loads; the header stays. */
	placeholder?: Html | undefined
}>

const rangeText = (startMs: number, endMs: number, timeZone: string) =>
	`${formatShiftEdge(startMs, timeZone)} to ${formatShiftEdge(endMs, timeZone)}`

/** The lanes as timeline rows: the final row on top, then the layers top first, as they stack. */
export const previewRows = <M>(options: CoveragePreviewOptions<M>): ReadonlyArray<TimelineRow<M>> => {
	const shiftBar = (shift: PreviewShift, key: string, isFinal: boolean): TimelineBar<M> => {
		const name = options.nameOf(shift.userId)
		const bar: TimelineBar<M> = {
			key,
			startMs: shift.startMs,
			endMs: shift.endMs,
			label: name,
			title: `${shift.isOverride ? "Override: " : ""}${name}, ${rangeText(shift.startMs, shift.endMs, options.timeZone)}`,
			tone: shift.isOverride ? "info" : isFinal ? "primary" : "neutral",
		}
		const click =
			isFinal && options.onFinalShift !== undefined ? options.onFinalShift(shift) : Option.none()
		return Option.match(click, { onNone: () => bar, onSome: (onClick) => ({ ...bar, onClick }) })
	}
	const gapBars = Arr.map(options.gaps, (gap, index): TimelineBar<M> => ({
		key: `gap-${gap.startMs}`,
		id: gapBarId(options.scope, index),
		startMs: gap.startMs,
		endMs: gap.endMs,
		label: "No one",
		title: `No one on call, ${gapRangeText(gap, options.timeZone)}`,
		tone: "warning",
	}))
	return [
		{
			key: "final",
			label: "Final schedule",
			detail: "Who gets paged",
			bars: [
				...Arr.map(options.final, (shift, index) => shiftBar(shift, `final-${index}`, true)),
				...gapBars,
			],
			emptyText: "Nobody on call in this period",
		},
		...Arr.reverse(
			Arr.map(options.lanes, (lane): TimelineRow<M> => ({
				key: lane.key,
				label: lane.label,
				detail: lane.detail,
				bars: Option.match(lane.shifts, {
					onNone: () => [],
					onSome: (shifts) =>
						Arr.map(shifts, (shift, at) => shiftBar(shift, `${lane.key}-${at}`, false)),
				}),
				emptyText: lane.emptyText,
			})),
		),
	]
}

/** "10 Nov to 23 Nov": the first and last day shown. */
const periodLabel = (fromMs: number, toMs: number, timeZone: string): string => {
	const day = new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" })
	return `${day.format(fromMs)} to ${day.format(toMs - 1)}`
}

const gapSummaryView = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html => {
	const days = Number(options.rangeDays)
	const summary = gapSummary(options.gaps, options.timeZone, options.weekOffset, days)
	const isCovered = options.gaps.length === 0
	return vstack(h, { gap: "1.5", attributes: [h.DataAttribute("slot", "coverage-summary")] }, [
		hstack(h, { gap: "1.5" }, [
			h.span(
				[h.AriaHidden(true), h.Class(isCovered ? "text-primary" : "text-warning-foreground")],
				[icon(h, isCovered ? "CircleCheckIcon" : "AlertWarningIcon")],
			),
			typography(h, { size: "sm", weight: "medium", as: "p", attributes: [h.AriaLive("polite")] }, [
				summary,
			]),
		]),
		...(isCovered
			? []
			: [
					hstack(h, { gap: "1", wrap: true }, [
						...Arr.map(Arr.take(options.gaps, MAX_GAP_LINKS), (gap, index) =>
							button(
								h,
								{
									size: "xs",
									variant: "outline",
									attributes: [
										h.Key(`gap-link-${gap.startMs}`),
										h.OnClick(options.onFocusGap(index)),
									],
								},
								[gapRangeText(gap, options.timeZone)],
							),
						),
						...(options.gaps.length > MAX_GAP_LINKS
							? [
									typography(
										h,
										{ size: "xs", tone: "muted", attributes: [h.Key("more")] },
										[`and ${options.gaps.length - MAX_GAP_LINKS} more on the timeline`],
									),
								]
							: []),
					]),
				]),
	])
}

export const coveragePreview = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html =>
	h.section(
		[h.Class("min-w-0 space-y-3"), h.DataAttribute("slot", "coverage-preview")],
		[
			hstack(h, { gap: "2", justify: "between", wrap: true }, [
				vstack(h, { gap: "0" }, [
					heading(h, { level: 2, variant: "section" }, [options.title]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						periodLabel(options.fromMs, options.toMs, options.timeZone),
					]),
				]),
				hstack(h, { gap: "1", wrap: true }, [
					segmentedSelect(h, {
						options: RANGE_OPTIONS,
						value: options.rangeDays,
						onChange: options.onRange,
						size: "xs",
						ariaLabel: "Range",
					}),
					iconButton(h, { label: "Previous week", attributes: [h.OnClick(options.onPrevious)] }, [
						icon(h, "ChevronLeftIcon"),
					]),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: options.weekOffset === 0,
							attributes: [h.OnClick(options.onToday)],
						},
						["Today"],
					),
					iconButton(h, { label: "Next week", attributes: [h.OnClick(options.onNext)] }, [
						icon(h, "ChevronRightIcon"),
					]),
				]),
			]),
			...(options.note === undefined
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, [options.note])]),
			...Arr.map(options.warnings ?? [], (warning) =>
				hstack(h, { gap: "1.5", attributes: [h.Key(warning)] }, [
					h.span(
						[h.AriaHidden(true), h.Class("text-warning-foreground")],
						[icon(h, "CircleInfoIcon")],
					),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [warning]),
				]),
			),
			...(options.placeholder === undefined
				? [gapSummaryView(h, options), timelineView(h, options)]
				: [options.placeholder]),
		],
	)

const timelineView = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html =>
	shiftTimeline(h, {
		fromMs: options.fromMs,
		toMs: options.toMs,
		timeZone: options.timeZone,
		nowMs: options.nowMs,
		zoneLabel: options.timeZone,
		rows: previewRows(options),
		ariaLabel: options.title,
		nowLabel: `Now, ${formatShiftEdge(options.nowMs, options.timeZone)}`,
		legend: [
			{ tone: "primary", label: "On call" },
			{ tone: "info", label: "Override" },
			{ tone: "neutral", label: "Layer shift" },
			{ tone: "warning", label: "No one" },
		],
	})
