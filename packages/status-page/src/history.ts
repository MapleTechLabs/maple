import type { StatusPageComponentStatus, StatusPageIncidentImpact } from "@maple/domain/primitives"
import {
	incidentComponentStatus,
	STATUS_PAGE_HISTORY_DAYS,
	STATUS_PAGE_WINDOW_DAYS,
	type StatusPageDayBar,
	type StatusPageIncidentHistoryEntry,
	type StatusPageSnapshot,
	type StatusPageSnapshotComponent,
	utcDay,
} from "@maple/domain/status-page"
import { INCIDENT_STATUS_LABEL, MONTHS } from "./format"
import { Option, Array as Arr, String as Str } from "effect"

// Paging and calendar rules for the page. The inline script mirrors `windowBounds`,
// `monthCells` and the labels; `script.test.ts` holds the two to the same answers.

const DAY_MS = 86_400_000

const dayMs = (day: string): number => {
	const [year, month = 1, date = 1] = Arr.map(Str.split("-")(day), Number)
	return Date.UTC(year, month - 1, date)
}

/** `day` moved by `offset` days. */
export const shiftDay = (day: string, offset: number): string => utcDay(dayMs(day) + offset * DAY_MS)

/** `Oct 2026` for a `YYYY-MM-DD` day. */
export const monthLabel = (day: string): string => {
	const [year, month = "1"] = Str.split("-")(day)
	return `${MONTHS[Number(month) - 1] ?? ""} ${year}`
}

/** Index range `[from, to)` of window `page` (0 is the latest) in `length` days; `from` may be negative. */
export const windowBounds = (
	length: number,
	page: number,
): { readonly from: number; readonly to: number } => {
	const to = length - page * STATUS_PAGE_WINDOW_DAYS
	return { from: to - STATUS_PAGE_WINDOW_DAYS, to }
}

/** The window's bars, padded with empty days before the oldest one the snapshot carries. */
export const windowDays = (
	days: ReadonlyArray<StatusPageDayBar>,
	page: number,
): ReadonlyArray<StatusPageDayBar> => {
	const last = days.at(-1)
	if (last === undefined) return []
	const { from } = windowBounds(days.length, page)
	return Array.from({ length: STATUS_PAGE_WINDOW_DAYS }, (_, offset) => {
		const index = from + offset
		return (
			days[index] ?? {
				day: shiftDay(last.day, index - (days.length - 1)),
				checks: 0,
				failures: 0,
				downChecks: 0,
			}
		)
	})
}

/** `Jul 2026 - Oct 2026`: the months a window spans. */
export const rangeLabel = (days: ReadonlyArray<StatusPageDayBar>): string => {
	const first = days[0]?.day
	const last = days.at(-1)?.day
	return first === undefined || last === undefined ? "" : `${monthLabel(first)} - ${monthLabel(last)}`
}

/** Components that draw bars. */
export const barComponents = (
	components: ReadonlyArray<StatusPageSnapshotComponent>,
): ReadonlyArray<StatusPageSnapshotComponent> =>
	Arr.filter(components, (component) => component.showUptime && component.days.length > 0)

/** Windows worth paging through: back to the oldest day any component was checked, at least one. */
export const windowCount = (components: ReadonlyArray<StatusPageSnapshotComponent>): number =>
	Arr.reduce(barComponents(components), 1, (count, component) => {
		return Option.match(
			Arr.findFirstIndex(component.days, (bar) => bar.checks > 0),
			{
				onNone: () => count,
				onSome: (oldest) =>
					Math.max(
						count,
						Math.floor((component.days.length - 1 - oldest) / STATUS_PAGE_WINDOW_DAYS) + 1,
					),
			},
		)
	})

/** Monday-first weeks of a month: day numbers, 0 for the padding cells. `month` is 1 to 12. */
export const monthCells = (year: number, month: number): ReadonlyArray<number> => {
	const lead = (new Date(Date.UTC(year, month - 1, 1)).getUTCDay() + 6) % 7
	const length = new Date(Date.UTC(year, month, 0)).getUTCDate()
	const cells = Math.ceil((lead + length) / 7) * 7
	return Array.from({ length: cells }, (_, index) => {
		const date = index - lead + 1
		return date >= 1 && date <= length ? date : 0
	})
}

/** `YYYY-MM` of the month `back` months before the one holding `day`. */
export const monthBefore = (day: string, back: number): string => {
	const [year, month = 1] = Arr.map(Str.split("-")(day), Number)
	const index = year * 12 + (month - 1) - back
	return `${Math.floor(index / 12)}-${Str.padStart(2, "0")(String((index % 12) + 1))}`
}

/** Months the calendar pages through: back to the one holding the oldest day of history. */
export const calendarMonthCount = (today: string): number => {
	const [year, month = 1] = Arr.map(Str.split("-")(today), Number)
	const [oldYear, oldMonth = 1] = Arr.map(
		Str.split("-")(shiftDay(today, 1 - STATUS_PAGE_HISTORY_DAYS)),
		Number,
	)
	return (year - oldYear) * 12 + (month - oldMonth) + 1
}

/** How a calendar day is marked: the worst incident impact, else maintenance. */
export type CalendarTone = Exclude<StatusPageComponentStatus, "operational"> | "notice"

const TONE_RANK = {
	notice: 0,
	maintenance: 1,
	degraded: 2,
	partial_outage: 3,
	major_outage: 4,
} as const satisfies Record<CalendarTone, number>

export interface CalendarEntry {
	readonly id: string
	readonly title: string
	readonly tone: CalendarTone
	readonly impact: StatusPageIncidentImpact
	readonly kind: StatusPageHistoryKind
	readonly status: string
	/** Listed on the page, so the calendar can link to it. */
	readonly listed: boolean
	readonly startedAt: number
	readonly resolvedAt: number | null
}

type StatusPageHistoryKind = StatusPageIncidentHistoryEntry["kind"]

const toneOf = (entry: Pick<StatusPageIncidentHistoryEntry, "kind" | "impact">): CalendarTone => {
	const status = incidentComponentStatus(entry)
	return status === "operational" ? "notice" : status
}

/**
 * The year's incidents for the calendar: the index, with what the page lists (including
 * break-glass ones not yet imported) taking precedence. Upcoming maintenance has no days yet.
 */
export const calendarEntries = (snapshot: StatusPageSnapshot): ReadonlyArray<CalendarEntry> => {
	const listed = Arr.filter(
		snapshot.incidents,
		(incident) => !(incident.kind === "maintenance" && incident.status === "scheduled"),
	)
	const listedIds = new Set(Arr.map(snapshot.incidents, (incident) => incident.id))
	const fromIndex = Arr.map(
		Arr.filter(
			snapshot.incidentHistory,
			(entry) => !Arr.some(listed, (incident) => incident.id === entry.id),
		),
		(entry) => ({
			...entry,
			status:
				entry.resolvedAt === null
					? "Ongoing"
					: INCIDENT_STATUS_LABEL[entry.kind === "incident" ? "resolved" : "completed"],
		}),
	)
	const fromList = Arr.map(listed, (incident) => ({
		id: incident.id,
		title: incident.title,
		kind: incident.kind,
		impact: incident.impact,
		startedAt: incident.startedAt,
		resolvedAt: incident.resolvedAt,
		status: INCIDENT_STATUS_LABEL[incident.status],
	}))
	return Arr.map(
		[...fromList, ...fromIndex].sort((a, b) => b.startedAt - a.startedAt),
		(entry) => ({ ...entry, tone: toneOf(entry), listed: listedIds.has(entry.id) }),
	)
}

export interface CalendarDay {
	readonly tone: CalendarTone
	/** Indexes into the entries, newest first. */
	readonly entries: ReadonlyArray<number>
}

/** Each UTC day an entry touched, from its start to its resolution (or today), within the history. */
export const calendarDays = (
	entries: ReadonlyArray<CalendarEntry>,
	nowMs: number,
): ReadonlyMap<string, CalendarDay> => {
	// Days as integers while counting, strings only once per distinct day: this runs on every render.
	const todayN = Math.floor(nowMs / DAY_MS)
	const oldestN = todayN + 1 - STATUS_PAGE_HISTORY_DAYS
	const byDay = new Map<number, { tone: CalendarTone; entries: Array<number> }>()
	Arr.forEach(entries, (entry, index) => {
		const firstN = Math.max(Math.floor(entry.startedAt / DAY_MS), oldestN)
		const endN = Math.min(Math.floor(Math.min(entry.resolvedAt ?? nowMs, nowMs) / DAY_MS), todayN)
		Arr.forEach(
			Array.from({ length: Math.max(0, endN - firstN + 1) }, (_, offset) => firstN + offset),
			(dayN) => {
				const current = byDay.get(dayN)
				if (current === undefined) {
					byDay.set(dayN, { tone: entry.tone, entries: [index] })
					return
				}
				if (TONE_RANK[entry.tone] > TONE_RANK[current.tone]) current.tone = entry.tone
				current.entries.push(index)
			},
		)
	})
	return new Map(Array.from(byDay, ([dayN, day]) => [utcDay(dayN * DAY_MS), day] as const))
}
