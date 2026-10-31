import { getSecurityExposure, getSecurityRuntimes } from "@maple/web-data/warehouse/security-telemetry"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { currentWindow } from "../../../data/time-range"
import { Message } from "./model"

// The two tabs' reads, over the last 7 days at the moment they run. Names start with `SecurityApi`
// (and the clock's with `ReadSecurity`) so the lab drops them.

export const WINDOW_PRESET = "7d"
/** Six-hour buckets: 28 bars over the week, the stat rail's spark length. */
export const TIMELINE_BUCKET_SECONDS = 6 * 3600

const lastWeek = (timeZone: string) => currentWindow({ preset: WINDOW_PRESET, snap: true, timeZone })

export const ReadSecurityTelemetryClock = Command.define("ReadSecurityTelemetryClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchExposure = Command.define("SecurityApiExposure", {
	args: { key: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedFetchExposure],
	execute: ({ key, timeZone }) =>
		lastWeek(timeZone).pipe(
			Effect.flatMap((window) =>
				getSecurityExposure({ data: { ...window, bucketSeconds: TIMELINE_BUCKET_SECONDS } }),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExposure({ key, result })),
		),
})

export const FetchRuntimes = Command.define("SecurityApiRuntimes", {
	args: { key: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedFetchRuntimes],
	execute: ({ key, timeZone }) =>
		lastWeek(timeZone).pipe(
			Effect.flatMap((window) => getSecurityRuntimes({ data: window })),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRuntimes({ key, result })),
		),
})
