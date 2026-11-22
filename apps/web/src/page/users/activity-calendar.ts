import { formatWarehouseDateTime } from "@maple/query-engine/datetime"
import { countLabel, EMPTY_VALUE, formatNumber } from "@maple/ui/lib/format"
import { contributionCalendar, type ContributionLevel } from "@maple/views/ui/contribution-calendar"
import { panel, panelHeader } from "@maple/views/ui/panel"
import type { TooltipRow } from "@maple/views/ui/tooltip-host"
import { formatExactCount } from "@maple/views/lib/locale"
import type { Tone } from "@maple/ui/lib/tone"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { Array as Arr, Order, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { UserActivityDay, UserCalendar } from "./data"

// The user page's activity calendar: one square per UTC day over the last year, shaded by how much
// the user did that day, over the habits the days add up to (streaks, busiest weekday). Days are
// UTC because `user_activity_daily` rolls up UTC days.

/** The days the calendar covers: `user_activity_daily` keeps 365. */
export const CALENDAR_DAYS = 365

const DAY_MS = 86_400_000

const WEEKDAY_NAMES = ["Sundays", "Mondays", "Tuesdays", "Wednesdays", "Thursdays", "Fridays", "Saturdays"]

const pad = (value: number): string => Str.padStart(2, "0")(String(value))

const isoDay = (ms: number): string => {
	const at = new Date(ms)
	return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
}

const dayStartMs = (day: string): number => {
	const [year, month = 1, date = 1] = Arr.map(Str.split("-")(day), Number)
	return Date.UTC(year, month - 1, date)
}

/** The calendar's UTC days, oldest first, ending today. */
export const calendarDays = (nowMs: number, count: number = CALENDAR_DAYS): ReadonlyArray<string> => {
	const today = Math.floor(nowMs / DAY_MS) * DAY_MS
	return Arr.makeBy(count, (index) => isoDay(today - (count - 1 - index) * DAY_MS))
}

/** A UTC day as the page's time range: its start and the next day's start. */
export const dayRange = (day: string): Readonly<{ startTime: string; endTime: string }> => {
	const startMs = dayStartMs(day)
	return {
		startTime: formatWarehouseDateTime(startMs),
		endTime: formatWarehouseDateTime(startMs + DAY_MS),
	}
}

/** What a day's square counts: everything the user did, each request, session and product event. */
export const dayTotal = (day: UserActivityDay): number => day.requests + day.sessions + day.events

/** A day's failures: failed requests and error log lines. */
export const dayErrors = (day: UserActivityDay): number => day.failedRequests + day.errorLogs

/**
 * A day's shade against the user's own active days, by quartile as GitHub does: a heavy API user
 * and a light one each spread over the whole ramp, and one huge day cannot wash out the rest.
 */
export const levelsOf = (totals: ReadonlyArray<number>): ((total: number) => ContributionLevel) => {
	const active = Arr.sort(
		Arr.filter(totals, (total) => total > 0),
		Order.Number,
	)
	const at = (quantile: number) => active[Math.floor((active.length - 1) * quantile)] ?? 0
	const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)]
	return (total) => (total <= 0 ? 0 : total <= q1 ? 1 : total <= q2 ? 2 : total <= q3 ? 3 : 4)
}

export type CalendarFacts = Readonly<{
	activeDays: number
	/** Active days in a row up to today, or up to yesterday when today has nothing yet. */
	currentStreak: number
	longestStreak: number
	/** 0 is Sunday; `null` without activity. */
	busiestWeekday: number | null
	errorDays: number
	totals: Readonly<{ requests: number; sessions: number; events: number }>
}>

export const calendarFacts = (
	days: ReadonlyArray<string>,
	byDay: ReadonlyMap<string, UserActivityDay>,
): CalendarFacts => {
	const isActive = (day: string) => {
		const entry = byDay.get(day)
		return entry !== undefined && dayTotal(entry) > 0
	}
	const runs = Arr.reduce(days, { current: 0, longest: 0 }, (run, day) => {
		const current = isActive(day) ? run.current + 1 : 0
		return { current, longest: Math.max(run.longest, current) }
	})
	const last = days[days.length - 1]
	// Today is not over: a streak that held until yesterday still stands.
	const currentStreak =
		last !== undefined && !isActive(last)
			? Arr.reduce(Arr.dropRight(days, 1), 0, (run, day) => (isActive(day) ? run + 1 : 0))
			: runs.current
	const entries = Arr.flatMap(days, (day) => {
		const entry = byDay.get(day)
		return entry === undefined ? [] : [entry]
	})
	const weekdayTotals = Arr.reduce(
		entries,
		Arr.makeBy(7, () => 0),
		(sums, entry) => {
			const weekday = new Date(dayStartMs(entry.day)).getUTCDay()
			return Arr.map(sums, (sum, index) => (index === weekday ? sum + dayTotal(entry) : sum))
		},
	)
	const busiest = Arr.reduce(weekdayTotals, { index: -1, total: 0 }, (best, total, index) =>
		total > best.total ? { index, total } : best,
	)
	const sum = (field: "requests" | "sessions" | "events") =>
		Arr.reduce(entries, 0, (total, entry) => total + entry[field])
	return {
		activeDays: Arr.filter(days, isActive).length,
		currentStreak,
		longestStreak: runs.longest,
		busiestWeekday: busiest.index < 0 ? null : busiest.index,
		errorDays: Arr.filter(entries, (entry) => dayErrors(entry) > 0).length,
		totals: { requests: sum("requests"), sessions: sum("sessions"), events: sum("events") },
	}
}

const dayTitle = (day: string): string =>
	new Intl.DateTimeFormat("en-GB", {
		timeZone: "UTC",
		weekday: "short",
		day: "numeric",
		month: "short",
		year: "numeric",
	}).format(dayStartMs(day))

const joinCounts = (parts: ReadonlyArray<string | null>, separator: string): string =>
	Arr.join(
		Arr.filter(parts, (part): part is string => part !== null),
		separator,
	)

/** A day's hover line: "Tue 17 Nov 2026: 412 requests, 3 sessions, 1 error". */
export const dayLine = (day: string, entry: UserActivityDay | undefined): string => {
	if (entry === undefined || (dayTotal(entry) === 0 && dayErrors(entry) === 0))
		return `${dayTitle(day)}: no activity`
	return `${dayTitle(day)}: ${joinCounts(
		[
			entry.requests > 0 ? countLabel(entry.requests, "request") : null,
			entry.sessions > 0 ? countLabel(entry.sessions, "session") : null,
			entry.events > 0 ? countLabel(entry.events, "event") : null,
			dayErrors(entry) > 0 ? countLabel(dayErrors(entry), "error") : null,
		],
		", ",
	)}`
}

/** A square's tooltip: the date as its title, then a row per kind the user did that day. */
export const dayTooltip = (
	day: string,
	entry: UserActivityDay | undefined,
): Readonly<{ title: string; rows: ReadonlyArray<TooltipRow>; hasErrors: boolean }> => {
	const row = (label: string, count: number, tone: Tone): ReadonlyArray<TooltipRow> =>
		count > 0 ? [{ label, value: formatExactCount(count), tone }] : []
	// The timeline's colours: a request is neutral, a replay session blue, an event cyan, an error red.
	const rows =
		entry === undefined
			? []
			: [
					...row("Requests", entry.requests, "neutral"),
					...row("Sessions", entry.sessions, "done"),
					...row("Events", entry.events, "info"),
					...row("Errors", dayErrors(entry), "crit"),
				]
	return { title: dayTitle(day), rows, hasErrors: entry !== undefined && dayErrors(entry) > 0 }
}

const dayCount = (count: number): string => (count === 1 ? "1 day" : `${formatNumber(count)} days`)

const totalsLine = (totals: CalendarFacts["totals"]): string => {
	const line = joinCounts(
		[
			totals.requests > 0 ? countLabel(totals.requests, "request") : null,
			totals.sessions > 0 ? countLabel(totals.sessions, "session") : null,
			totals.events > 0 ? countLabel(totals.events, "event") : null,
		],
		" · ",
	)
	return line === "" ? "No activity in the last year" : `${line} in the last year`
}

export type ActivityCalendarOptions = Readonly<{
	calendar: UserCalendar
	nowMs: number
	/** The page scoped to one UTC day; the squares link to it. */
	dayHref?: (range: Readonly<{ startTime: string; endTime: string }>) => string
}>

/** The calendar's frame while its read is out or after it failed, about the calendar's height. */
const placeholder = <M>(h: HtmlBuilder<M>, text: string): Html =>
	hstack(h, { justify: "center", className: "h-44 px-4" }, [
		typography(h, { size: "xs", tone: "muted" }, [text]),
	])

/** One habit under the calendar: the value over its label. */
const fact = <M>(h: HtmlBuilder<M>, label: string, value: string, isError = false): Html =>
	vstack(h, { gap: "0.5", className: "min-w-0" }, [
		typography(
			h,
			{ size: "sm", weight: "medium", numeric: true, tone: isError ? "error" : "foreground" },
			[value],
		),
		typography(h, { size: "2xs", tone: "muted", truncate: true }, [label]),
	])

const calendarBody = <M>(
	h: HtmlBuilder<M>,
	rows: ReadonlyArray<UserActivityDay>,
	options: ActivityCalendarOptions,
): Html => {
	const days = calendarDays(options.nowMs)
	const byDay = new Map(Arr.map(rows, (row) => [row.day, row] as const))
	const levelOf = levelsOf(Arr.map(rows, dayTotal))
	const facts = calendarFacts(days, byDay)
	return vstack(h, { gap: "0" }, [
		contributionCalendar(h, {
			ariaLabel: "Activity per UTC day over the last year",
			className: "px-4 pt-4 pb-3",
			summary: "Days in UTC",
			days: Arr.map(days, (day) => {
				const entry = byDay.get(day)
				const tooltip = dayTooltip(day, entry)
				return {
					day,
					level: levelOf(entry === undefined ? 0 : dayTotal(entry)),
					label: dayLine(day, entry),
					tooltip: {
						content: tooltip.rows.length === 0 ? "No activity" : " ",
						title: tooltip.title,
						rows: tooltip.rows,
						icon: tooltip.hasErrors ? "CircleWarningIcon" : "CalendarIcon",
						tone: tooltip.hasErrors ? "crit" : "neutral",
						...(options.dayHref !== undefined &&
							tooltip.rows.length > 0 && { footer: "Click to see this day" }),
					},
					...(options.dayHref !== undefined && { href: options.dayHref(dayRange(day)) }),
				}
			}),
		}),
		h.div(
			[
				h.Class(
					"grid grid-cols-2 gap-x-6 gap-y-3 border-t border-border-subtle px-4 py-3 @lg/panel:grid-cols-5",
				),
			],
			[
				fact(h, "Active days", `${formatNumber(facts.activeDays)} of ${CALENDAR_DAYS}`),
				fact(h, "Current streak", dayCount(facts.currentStreak)),
				fact(h, "Longest streak", dayCount(facts.longestStreak)),
				fact(
					h,
					"Busiest on",
					facts.busiestWeekday === null
						? EMPTY_VALUE
						: (WEEKDAY_NAMES[facts.busiestWeekday] ?? EMPTY_VALUE),
				),
				fact(h, "Days with an error", formatNumber(facts.errorDays), facts.errorDays > 0),
			],
		),
	])
}

/** The card's header line: the year's totals once they are in, else just the range. */
const headerLine = (calendar: UserCalendar, nowMs: number): string =>
	typeof calendar === "string"
		? "Last year"
		: totalsLine(
				calendarFacts(
					calendarDays(nowMs),
					new Map(Arr.map(calendar.days, (row) => [row.day, row] as const)),
				).totals,
			)

/** The Activity tab's calendar card: the last year, a square per day, and the habits under it. */
export const activityCalendar = <M>(h: HtmlBuilder<M>, options: ActivityCalendarOptions): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "Daily activity",
			action: typography(h, { size: "xs", tone: "muted" }, [
				headerLine(options.calendar, options.nowMs),
			]),
		}),
		options.calendar === "loading"
			? placeholder(h, "Loading this user's last year…")
			: options.calendar === "failed"
				? placeholder(h, "Couldn't load this user's last year")
				: calendarBody(h, options.calendar.days, options),
	])
