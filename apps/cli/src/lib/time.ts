import { Clock, Data, Effect, Match, Option } from "effect"

export class InvalidTimeRange extends Data.TaggedError("@maple/cli/lib/InvalidTimeRange")<{
	readonly message: string
	readonly input: string
}> {}

const pad = (n: number) => String(n).padStart(2, "0")

const formatDateTimeUTC = (d: Date): string =>
	`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`

const parseSince = Effect.fnUntraced(function* (since: string) {
	const match = since.match(/^(\d+)(m|h|d)$/)
	if (!match) {
		return yield* new InvalidTimeRange({
			message: `Invalid --since format: "${since}". Use e.g. 30m, 6h, 7d`,
			input: since,
		})
	}
	const [, num, unit] = match
	const n = Number(num)
	return Match.value(unit).pipe(
		Match.when("m", () => n * 60 * 1000),
		Match.when("h", () => n * 60 * 60 * 1000),
		Match.when("d", () => n * 24 * 60 * 60 * 1000),
		Match.orElse(() => n * 60 * 1000),
	)
})

export const resolveTimeRange = Effect.fnUntraced(function* (opts: {
	since: string
	start: Option.Option<string>
	end: Option.Option<string>
}) {
	if (Option.isSome(opts.start) && Option.isSome(opts.end)) {
		return { startTime: opts.start.value, endTime: opts.end.value }
	}

	// Clock-sourced wall clock (testable) instead of a raw `new Date()`.
	const nowMs = yield* Clock.currentTimeMillis
	const now = new Date(nowMs)
	const endTime = Option.isSome(opts.end) ? opts.end.value : formatDateTimeUTC(now)
	const startMs = Option.isSome(opts.start)
		? new Date(opts.start.value).getTime()
		: nowMs - (yield* parseSince(opts.since))

	const startTime = Option.isSome(opts.start) ? opts.start.value : formatDateTimeUTC(new Date(startMs))

	return { startTime, endTime }
})
