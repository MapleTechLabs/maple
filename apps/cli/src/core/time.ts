// Time-range resolution for the CLI commands. Every bound leaves here as a
// ClickHouse-style `YYYY-MM-DD HH:mm:ss` UTC string, whatever the user typed.

import { Clock, Effect, Option, Result, Schema } from "effect"

export interface Range {
	readonly startTime: string
	readonly endTime: string
}

/** A bad `--since` / time-range input, surfaced to the user with a hint. */
export class TimeRangeError extends Schema.TaggedError<TimeRangeError>()("@maple/cli/TimeRangeError", {
	message: Schema.String,
	hint: Schema.optionalKey(Schema.String),
}) {}

const pad = (n: number): string => String(n).padStart(2, "0")

export const formatDateTimeUTC = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
	`${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

const SINCE_RE = /^(\d+)(m|h|d|w)$/
const UNIT_MS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const

/** Parse a relative window like `30m`, `6h`, `7d`, `2w` to milliseconds. */
export const sinceToMs = (since: string): number | null => {
	const match = since.trim().match(SINCE_RE)
	if (!match) return null
	const unit = match[2]
	const n = Number(match[1])
	return unit === "m" || unit === "h" || unit === "d" || unit === "w" ? n * UNIT_MS[unit] : null
}

// `YYYY-MM-DD`, optionally followed by ` HH:mm[:ss[.fff]]` or `THH:mm[:ss[.fff]]`
// and a zone (`Z`, `+02:00`, `-0500`). No zone means UTC, the same as the
// ClickHouse form the help text advertises.
const TIMESTAMP_RE =
	/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?)?\s*(Z|z|[+-]\d{2}:?\d{2})?$/

const zoneOffsetMs = (zone: string | undefined): number => {
	if (zone === undefined || zone === "Z" || zone === "z") return 0
	const sign = zone.startsWith("-") ? -1 : 1
	const digits = zone.slice(1).replace(":", "")
	return sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4))) * 60_000
}

/**
 * Parse an absolute timestamp to epoch milliseconds (whole seconds). Accepts
 * ClickHouse `YYYY-MM-DD HH:mm:ss` (UTC), a bare date, and ISO-8601 with or
 * without a zone.
 */
export const parseTimestampMs = (input: string): number | null => {
	const match = input.trim().match(TIMESTAMP_RE)
	if (!match) return null
	const [, y, mo, d, h = "00", mi = "00", s = "00", zone] = match
	const year = Number(y)
	const month = Number(mo)
	const day = Number(d)
	const hour = Number(h)
	const minute = Number(mi)
	const second = Number(s)
	const utc = Date.UTC(year, month - 1, day, hour, minute, second)
	// Date.UTC rolls 2026-02-31 over to March; a round trip catches that.
	const check = new Date(utc)
	if (
		check.getUTCFullYear() !== year ||
		check.getUTCMonth() !== month - 1 ||
		check.getUTCDate() !== day ||
		check.getUTCHours() !== hour ||
		check.getUTCMinutes() !== minute ||
		check.getUTCSeconds() !== second
	) {
		return null
	}
	return utc - zoneOffsetMs(zone)
}

/** Normalize one `--start`/`--end` value to the ClickHouse UTC form. */
export const normalizeTimestamp = (input: string, flag: string): Result.Result<string, TimeRangeError> => {
	const ms = parseTimestampMs(input)
	return ms === null
		? Result.fail(
				new TimeRangeError({
					message: `invalid ${flag} "${input}": expected 'YYYY-MM-DD HH:mm:ss' (UTC) or ISO-8601 like 2026-09-25T22:00:00Z`,
				}),
			)
		: Result.succeed(formatDateTimeUTC(new Date(ms)))
}

/**
 * Resolve a `{ since, start, end }` flag set to an absolute `Range`. `--start`
 * and `--end` together win; `--start` alone runs to now; `--end` alone looks
 * back `--since` from it; neither is `now - since … now`. A window that is
 * empty or inverted is an error rather than a silent `[]`.
 */
export const resolveRangeChecked = (a: {
	readonly since: string
	readonly start: Option.Option<string>
	readonly end: Option.Option<string>
}): Effect.Effect<Range, TimeRangeError> =>
	Effect.gen(function* () {
		const optional = (
			value: Option.Option<string>,
			flag: string,
		): Result.Result<string | undefined, TimeRangeError> =>
			Option.match(value, {
				onNone: () => Result.succeed(undefined),
				onSome: (input) => normalizeTimestamp(input, flag),
			})
		const start = yield* Effect.fromResult(optional(a.start, "--start"))
		const end = yield* Effect.fromResult(optional(a.end, "--end"))

		let range: Range
		if (start !== undefined && end !== undefined) {
			range = { startTime: start, endTime: end }
		} else {
			const ms = sinceToMs(a.since)
			if (ms === null) {
				return yield* new TimeRangeError({
					message: `invalid --since "${a.since}": use a number and a unit, m, h, d or w (e.g. 30m, 6h, 7d)`,
				})
			}
			if (ms === 0) {
				return yield* new TimeRangeError({
					message: `--since must be longer than zero (got "${a.since}")`,
				})
			}
			const nowMs = yield* Clock.currentTimeMillis
			const endMs = end === undefined ? nowMs : (parseTimestampMs(end) ?? nowMs)
			range = {
				startTime: start ?? formatDateTimeUTC(new Date(endMs - ms)),
				endTime: end ?? formatDateTimeUTC(new Date(nowMs)),
			}
		}
		// Same-format UTC strings order lexicographically.
		if (range.startTime >= range.endTime) {
			return yield* new TimeRangeError({
				message: `--start must be before --end (got ${range.startTime} to ${range.endTime} UTC)`,
			})
		}
		return range
	})

/** "the last 6h", or the absolute window, for "nothing found in …" messages. */
export const describeWindow = (
	a: { readonly since: string; readonly start: Option.Option<string>; readonly end: Option.Option<string> },
	range: Range,
): string =>
	Option.isNone(a.start) && Option.isNone(a.end)
		? `the last ${a.since}`
		: `${range.startTime} to ${range.endTime} UTC`
