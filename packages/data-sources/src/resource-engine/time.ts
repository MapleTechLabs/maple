import { Array as Arr, DateTime, Option } from "effect"

/**
 * Time buckets are UTC-aligned to the granularity and reported as ISO 8601 strings
 * (`2026-11-01T00:00:00.000Z`) in a `bucket` column of type `timestamp`, like SQL time groups.
 */
export interface Bucket {
	readonly startMs: number
	/** Exclusive, clipped to the window end. */
	readonly endMs: number
}

export const bucketStart = (ms: number, granularitySeconds: number): number => {
	const width = granularitySeconds * 1000
	return Math.floor(ms / width) * width
}

/** Every bucket overlapping `[startMs, endMs)`, each clipped to the window. */
export const bucketsFor = (
	startMs: number,
	endMs: number,
	granularitySeconds: number,
): ReadonlyArray<Bucket> => {
	const width = granularitySeconds * 1000
	const first = bucketStart(startMs, granularitySeconds)
	const count = endMs <= startMs ? 0 : Math.ceil((endMs - first) / width)
	return Arr.makeBy(count, (index) => {
		const start = first + index * width
		return { startMs: Math.max(start, startMs), endMs: Math.min(start + width, endMs) }
	})
}

export const bucketCount = (startMs: number, endMs: number, granularitySeconds: number): number =>
	endMs <= startMs
		? 0
		: Math.ceil((endMs - bucketStart(startMs, granularitySeconds)) / (granularitySeconds * 1000))

export const toIso = (ms: number): string => new Date(ms).toISOString()

const ZONED = /(Z|[+-]\d\d:?\d\d)$/

/** Epoch ms from a number or an ISO string with a zone (`Z` or an offset); `null` otherwise. */
export const toEpochMs = (value: unknown): number | null => {
	if (typeof value === "number" && Number.isFinite(value)) return value
	if (typeof value !== "string" || !ZONED.test(value)) return null
	return Option.match(DateTime.make(value), { onNone: () => null, onSome: DateTime.toEpochMillis })
}

const DAY = 86_400
/** "1 day", "6 hours", "5 minutes". */
const unit = (count: number, word: string): string => `${count} ${word}${count === 1 ? "" : "s"}`

/** `86400` -> "1 day", `7200` -> "2 hours", `60` -> "1 minute", `30` -> "30 seconds". */
export const describeGranularity = (seconds: number): string =>
	seconds % DAY === 0
		? unit(seconds / DAY, "day")
		: seconds % 3600 === 0
			? unit(seconds / 3600, "hour")
			: seconds % 60 === 0
				? unit(seconds / 60, "minute")
				: unit(seconds, "second")
