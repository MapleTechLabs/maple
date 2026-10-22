import { formatWarehouseDateTime, resolveRelativeRangeToWarehouse, snapRangeForCache } from "@maple/query-engine"
import { snapTimestamp } from "@maple/web-data/lib/time-range"
import { normalizeTimestampInput } from "@maple/web-data/lib/timezone-format"
import { Clock, Effect, Option, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import { linkedCursorStream } from "../../../charts/linked-cursor"
import type { TimeWindow } from "../../../data/time-range"
import { Message } from "./model"

const DEFAULT_PAD_MS = 15 * 60_000
const FALLBACK_PRESET = "30m"

/**
 * `infraCorrelationWindow` for a parseable anchor: 15 minutes either side, covering the span, on
 * snapped to a 15 s grid before the request is sent.
 */
export const anchoredWindow = (anchor: string, spanDurationMs: number): Option.Option<TimeWindow> => {
	const anchorMs = new Date(normalizeTimestampInput(anchor)).getTime()
	if (Number.isNaN(anchorMs)) return Option.none()
	return Option.some({
		startTime: snapTimestamp(formatWarehouseDateTime(anchorMs - DEFAULT_PAD_MS)),
		endTime: snapTimestamp(formatWarehouseDateTime(Math.trunc(anchorMs + spanDurationMs) + DEFAULT_PAD_MS)),
	})
}

/** An unparseable anchor falls back to the last 30 minutes, snapped (it reads the clock). */
const correlationWindow = (anchor: string, spanDurationMs: number, timeZone: string): Effect.Effect<TimeWindow> =>
	Option.match(anchoredWindow(anchor, spanDurationMs), {
		onSome: Effect.succeed,
		onNone: () =>
			Effect.map(Clock.currentTimeMillis, (nowMs) => {
				const range = resolveRelativeRangeToWarehouse(FALLBACK_PRESET, nowMs, timeZone)
				return range === null ? { startTime: "", endTime: "" } : snapRangeForCache(range)
			}),
	})

/** The panel root: resolves its window as the charts mount, and runs their linked cursor. */
export const MountInfraCorrelation = Mount.defineStream("MountInfraCorrelation", {
	args: {
		anchor: Schema.String,
		spanDurationMs: Schema.Number,
		timeZone: Schema.String,
		resourceAttributes: Schema.Record(Schema.String, Schema.String),
	},
	messages: [Message.ResolvedWindow, Message.CompletedMountLinkedCursor],
	execute: ({ element, anchor, spanDurationMs, timeZone, resourceAttributes }) =>
		Stream.merge(
			Stream.fromEffect(
				Effect.map(correlationWindow(anchor, spanDurationMs, timeZone), (window) =>
					Message.ResolvedWindow({ window, resourceAttributes }),
				),
			),
			linkedCursorStream(element, Message.CompletedMountLinkedCursor()),
		),
})
