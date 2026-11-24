// An on-call schedule as an iCalendar feed (RFC 5545): one event per shift, in UTC, so a
// calendar app can subscribe to it by URL.
import { Array as Arr, pipe, String as Str } from "effect"

export interface CalendarShift {
	readonly userId: string
	readonly startMs: number
	readonly endMs: number
}

export interface OnCallCalendarInput {
	/** Stable across renders: a calendar app matches a shift it already holds by this and its start. */
	readonly scheduleId: string
	readonly scheduleName: string
	readonly shifts: ReadonlyArray<CalendarShift>
	/** The person's display name, or null when the directory does not know them. */
	readonly nameOf: (userId: string) => string | null
	/** When the feed was rendered: every event's DTSTAMP. */
	readonly nowMs: number
}

const CRLF = "\r\n"
/** Content lines are folded at 75 octets (RFC 5545 3.1); a continuation starts with one space. */
const MAX_LINE_OCTETS = 75

const encoder = new TextEncoder()

const pad = (value: number, width = 2): string => Str.padStart(width, "0")(String(value))

/** `20261110T080000Z`: a UTC date-time in the basic format. */
export const icsDateTime = (ms: number): string => {
	const at = new Date(ms)
	return `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}T${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}Z`
}

/** TEXT escaping (RFC 5545 3.3.11): backslash, semicolon, comma and line breaks. */
export const icsText = (value: string): string =>
	pipe(
		value,
		Str.replaceAll("\\", "\\\\"),
		Str.replaceAll(";", "\\;"),
		Str.replaceAll(",", "\\,"),
		Str.replace(/\r\n|\r|\n/g, "\\n"),
	)

type FoldState = Readonly<{ lines: ReadonlyArray<string>; current: string; octets: number }>

/** One content line, folded so no physical line is longer than 75 octets and no character is split. */
export const foldIcsLine = (line: string): string => {
	const start: FoldState = { lines: [], current: "", octets: 0 }
	const folded = Arr.reduce(Arr.fromIterable(line), start, (state, character): FoldState => {
		const size = encoder.encode(character).length
		// A continuation line spends one octet on its leading space.
		const limit = state.lines.length === 0 ? MAX_LINE_OCTETS : MAX_LINE_OCTETS - 1
		return state.octets + size > limit
			? { lines: [...state.lines, state.current], current: character, octets: size }
			: { lines: state.lines, current: state.current + character, octets: state.octets + size }
	})
	return Arr.join([...folded.lines, folded.current], `${CRLF} `)
}

const eventLines = (input: OnCallCalendarInput, shift: CalendarShift): ReadonlyArray<string> => {
	const who = input.nameOf(shift.userId)
	return [
		"BEGIN:VEVENT",
		`UID:${input.scheduleId}-${shift.startMs}-${shift.userId}@maple.dev`,
		`DTSTAMP:${icsDateTime(input.nowMs)}`,
		`DTSTART:${icsDateTime(shift.startMs)}`,
		`DTEND:${icsDateTime(shift.endMs)}`,
		`SUMMARY:${icsText(`On call: ${who ?? "unknown"} (${input.scheduleName})`)}`,
		// Shown as free time: being on call is not a meeting.
		"TRANSP:TRANSPARENT",
		"END:VEVENT",
	]
}

/** The feed's body: a VCALENDAR with one VEVENT per shift, CRLF line endings, folded lines. */
export const renderOnCallCalendar = (input: OnCallCalendarInput): string =>
	`${Arr.join(
		Arr.map(
			[
				"BEGIN:VCALENDAR",
				"VERSION:2.0",
				"PRODID:-//Maple//On-call schedule//EN",
				"CALSCALE:GREGORIAN",
				"METHOD:PUBLISH",
				`X-WR-CALNAME:${icsText(`On call: ${input.scheduleName}`)}`,
				// Ask subscribers to come back hourly; most apps treat it as a floor.
				"REFRESH-INTERVAL;VALUE=DURATION:PT1H",
				"X-PUBLISHED-TTL:PT1H",
				...Arr.flatMap(input.shifts, (shift) => eventLines(input, shift)),
				"END:VCALENDAR",
			],
			foldIcsLine,
		),
		CRLF,
	)}${CRLF}`
