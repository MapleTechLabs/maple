import { readClock } from "@maple/views/data/timing"
import { getSecurityExposure, getSecurityRuntimes } from "@maple/web-data/warehouse/security-telemetry"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { currentWindow } from "../../../data/time-range"
import { Message } from "./model"

// The two tabs' reads, over the last 7 days at the moment they run. Names start with `SecurityApi`
// (and the clock's with `ReadSecurity`) so the lab drops them.

export const WINDOW_PRESET = "7d"
/** Six-hour buckets: 28 bars over the week, the stat rail's spark length. */
export const TIMELINE_BUCKET_SECONDS = 6 * 3600

const lastWeek = (timeZone: string) => currentWindow({ preset: WINDOW_PRESET, snap: true, timeZone })

export const ReadSecurityTelemetryClock = readClock("ReadSecurityTelemetryClock", Message.ReadClock)

export const FetchExposure = Command.define("SecurityApiExposure", {
	args: { key: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedFetchExposure],
	execute: ({ key, timeZone }) =>
		lastWeek(timeZone).pipe(
			Effect.flatMap((window) =>
				getSecurityExposure({ data: { ...window, bucketSeconds: TIMELINE_BUCKET_SECONDS } }),
			),
			settleTo((result) => Message.CompletedFetchExposure({ key, result })),
		),
})

export const FetchRuntimes = Command.define("SecurityApiRuntimes", {
	args: { key: Schema.String, timeZone: Schema.String },
	messages: [Message.CompletedFetchRuntimes],
	execute: ({ key, timeZone }) =>
		lastWeek(timeZone).pipe(
			Effect.flatMap((window) => getSecurityRuntimes({ data: window })),
			settleTo((result) => Message.CompletedFetchRuntimes({ key, result })),
		),
})
