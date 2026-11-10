import { initialsFrom } from "@maple/ui/lib/initials"
import { Array as Arr, Effect, Option, Schema, String as Str } from "effect"
import { Command, Dom } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "@maple/views/ui/button"
import { heading } from "@maple/views/ui/heading"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { shiftTimeline, type TimelineBar, type TimelineRow } from "@maple/views/ui/shift-timeline"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { formatShiftEdge } from "./oncall-schedules"
import { gapRangeText, gapSummary, isUncovered, type Interval } from "./schedule-coverage"

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

/** The summary links this many gaps in a narrow preview and in a wide one; the rest are on the timeline. */
const NARROW_GAP_LINKS = 3
const WIDE_GAP_LINKS = 6

/** The element id of a gap's bar, so its summary link can scroll to and focus it. */
export const gapBarId = (scope: string, index: number): string => `${scope}-gap-${index}`

export const GapFocusMessage = defineMessageUnion({ CompletedFocusGap: {} })

/** A gap's bar takes focus, which scrolls it into view; a page lifts the result into its own message. */
export const FocusGap = Command.define("FocusCoverageGap", {
	args: { scope: Schema.String, index: Schema.Number },
	messages: [GapFocusMessage.CompletedFocusGap],
	execute: ({ scope, index }) =>
		Dom.focus(`#${gapBarId(scope, index)}`).pipe(
			Effect.ignore,
			Effect.as(GapFocusMessage.CompletedFocusGap()),
		),
})

export type PreviewShift = Readonly<{ userId: string; startMs: number; endMs: number; isOverride: boolean }>

export type PreviewLane = Readonly<{
	key: string
	label: string
	detail: string
	/** None while the layer cannot be drawn; `emptyText` says why. */
	shifts: Option.Option<ReadonlyArray<PreviewShift>>
	emptyText: string
}>

/** A plain-language line over the timeline: `warn` changes what is covered, `info` only explains. */
export type PreviewNote = Readonly<{ tone: "info" | "warn"; text: string }>

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
	/** A draft has no past: its preview cannot step back from today. */
	isPreviousDisabled?: boolean
	/** A final shift's bar action (the detail page's "cover with an override"). */
	onFinalShift?: (shift: PreviewShift) => Option.Option<M>
	notes?: ReadonlyArray<PreviewNote>
	/** A line under the header. The axis names the zone, so this does not. */
	note?: string | undefined
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
			shortLabel: initialsFrom(name),
			title: `${shift.isOverride ? "Override: " : ""}${name}, ${rangeText(shift.startMs, shift.endMs, options.timeZone)}`,
			tone: shift.isOverride ? "info" : isFinal ? "primary" : "neutral",
		}
		const click =
			isFinal && options.onFinalShift !== undefined ? options.onFinalShift(shift) : Option.none()
		return Option.match(click, { onNone: () => bar, onSome: (onClick) => ({ ...bar, onClick }) })
	}
	const gapBars = Arr.map(options.gaps, (gap, index): TimelineBar<M> => {
		const range = gapRangeText(gap, options.timeZone, options.toMs)
		return {
			key: `gap-${gap.startMs}`,
			id: gapBarId(options.scope, index),
			startMs: gap.startMs,
			endMs: gap.endMs,
			label: "No one",
			// An open gap reads "No one on call from Sat 21 Nov 08:00".
			title: Str.startsWith("from ")(range) ? `No one on call ${range}` : `No one on call, ${range}`,
			tone: "gap",
		}
	})
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
				// The final row above already carries every shift that pages; these stay out of the tab order.
				isTabStop: false,
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

const summaryLine = <M>(
	h: HtmlBuilder<M>,
	iconName: "CircleCheckIcon" | "AlertWarningIcon" | "ClockIcon",
	iconClass: string,
	text: string,
): Html =>
	hstack(h, { gap: "1.5", align: "start" }, [
		h.span([h.AriaHidden(true), h.Class(`mt-0.5 shrink-0 ${iconClass}`)], [icon(h, iconName)]),
		typography(h, { size: "sm", weight: "medium", as: "p", attributes: [h.AriaLive("polite")] }, [text]),
	])

const gapLinks = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html => {
	const count = options.gaps.length
	const more = (shown: number, className: string): ReadonlyArray<Html> =>
		count > shown
			? [
					typography(
						h,
						{ size: "xs", tone: "muted", className, attributes: [h.Key(`more-${shown}`)] },
						[`and ${count - shown} more on the timeline`],
					),
				]
			: []
	return hstack(h, { gap: "1", wrap: true }, [
		...Arr.map(Arr.take(options.gaps, WIDE_GAP_LINKS), (gap, index) =>
			button(
				h,
				{
					size: "xs",
					variant: "outline",
					// A narrow preview (a phone) links fewer gaps.
					className: index < NARROW_GAP_LINKS ? undefined : "hidden @min-[30rem]:inline-flex",
					attributes: [h.Key(`gap-link-${gap.startMs}`), h.OnClick(options.onFocusGap(index))],
				},
				[Str.capitalize(gapRangeText(gap, options.timeZone, options.toMs))],
			),
		),
		...more(NARROW_GAP_LINKS, "@min-[30rem]:hidden"),
		...more(WIDE_GAP_LINKS, "hidden @min-[30rem]:inline"),
	])
}

const gapSummaryView = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html => {
	const scope = {
		timeZone: options.timeZone,
		weekOffset: options.weekOffset,
		days: Number(options.rangeDays),
		checkedFromMs: Math.max(options.fromMs, options.nowMs),
		checkedToMs: options.toMs,
	}
	const summary = gapSummary(options.gaps, scope)
	const alarm = summaryLine(h, "AlertWarningIcon", "text-severity-error", summary)
	const body =
		// A range that has wholly passed has nothing left to check.
		options.toMs <= options.nowMs
			? [
					summaryLine(
						h,
						"ClockIcon",
						"text-muted-foreground",
						"Past shifts. Gaps are only checked from now.",
					),
				]
			: options.gaps.length === 0
				? [summaryLine(h, "CircleCheckIcon", "text-severity-info", summary)]
				: // One gap that is the whole range needs no link to find it.
					isUncovered(options.gaps, scope)
					? [alarm]
					: [alarm, gapLinks(h, options)]
	return vstack(h, { gap: "1.5", attributes: [h.DataAttribute("slot", "coverage-summary")] }, body)
}

const noteView = <M>(h: HtmlBuilder<M>, note: PreviewNote): Html =>
	hstack(h, { gap: "1.5", align: "start", attributes: [h.Key(note.text)] }, [
		h.span(
			[
				h.AriaHidden(true),
				h.Class(
					`mt-0.5 shrink-0 ${note.tone === "warn" ? "text-severity-warn" : "text-muted-foreground"}`,
				),
			],
			[icon(h, note.tone === "warn" ? "CircleWarningIcon" : "CircleInfoIcon", { size: 14 })],
		),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [note.text]),
	])

const controls = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html =>
	// The range switch takes its own row in a narrow preview; the week steps never split.
	vstack(h, { gap: "2", className: "@min-[30rem]:flex-row @min-[30rem]:items-center" }, [
		segmentedSelect(h, {
			options: RANGE_OPTIONS,
			value: options.rangeDays,
			onChange: options.onRange,
			size: "xs",
			ariaLabel: "Range",
			className: "w-fit",
		}),
		hstack(h, { gap: "1", className: "shrink-0" }, [
			iconButton(
				h,
				{
					label: "Previous week",
					isDisabled: options.isPreviousDisabled ?? false,
					attributes: [h.OnClick(options.onPrevious)],
				},
				[icon(h, "ChevronLeftIcon")],
			),
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
	])

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
			{ tone: "gap", label: "No one" },
		],
	})

export const coveragePreview = <M>(h: HtmlBuilder<M>, options: CoveragePreviewOptions<M>): Html =>
	h.section(
		// A container: the controls and gap links lay out by the preview's width, not the screen's.
		[h.Class("@container min-w-0 space-y-3"), h.DataAttribute("slot", "coverage-preview")],
		[
			hstack(h, { gap: "2", justify: "between", align: "start", wrap: true }, [
				vstack(h, { gap: "0" }, [
					heading(h, { level: 2, variant: "section" }, [options.title]),
					typography(h, { size: "xs", tone: "muted", as: "p" }, [
						periodLabel(options.fromMs, options.toMs, options.timeZone),
					]),
				]),
				controls(h, options),
			]),
			...(options.note === undefined
				? []
				: [typography(h, { size: "xs", tone: "muted", as: "p" }, [options.note])]),
			...Arr.map(options.notes ?? [], (note) => noteView(h, note)),
			...(options.placeholder === undefined
				? [gapSummaryView(h, options), timelineView(h, options)]
				: [options.placeholder]),
		],
	)
