import {
	isHostedLocation,
	localApiBaseForLocation,
	localOtlpEndpointForLocation,
	localServerPortForLocation,
} from "./lib/constants"
import { DEFAULT_RANGE, isRangeKey } from "./lib/time"
import { readLocalStorage } from "@maple/ui/lib/local-storage"
import { Effect, Option, Schema } from "effect"
import type { TimeFormat } from "./page/kit/local-time"

/**
 * Where this page reaches its server (apps/local-ui/src/lib/constants.ts), read once from
 * `window.location` before init: same origin, or loopback from a hosted origin.
 */
export const LocalEnv = Schema.Struct({
	apiBase: Schema.String,
	port: Schema.String,
	otlpEndpoint: Schema.String,
	isHosted: Schema.Boolean,
})
export type LocalEnv = typeof LocalEnv.Type

export const readLocalEnv: Effect.Effect<LocalEnv> = Effect.sync(() => ({
	apiBase: localApiBaseForLocation(window.location),
	port: localServerPortForLocation(window.location),
	otlpEndpoint: localOtlpEndpointForLocation(window.location),
	isHosted: isHostedLocation(window.location),
}))

/** The per-browser memory of the last picked range. */
export const RANGE_STORAGE_KEY = "maple-local:range"

export const readRememberedRange: Effect.Effect<string> = Effect.sync(() =>
	Option.getOrElse(Option.filter(readLocalStorage(RANGE_STORAGE_KEY), isRangeKey), () => DEFAULT_RANGE),
)

/** The shared provider persists the collapsed state in this cookie but leaves reading it to the app. */
export const readSidebarOpen: Effect.Effect<boolean> = Effect.sync(
	() => !document.cookie.split("; ").includes("sidebar_state=false"),
)

export const Theme = Schema.Literals(["light", "dark"])
export type Theme = typeof Theme.Type

/** Follow the OS theme; dark stays the default when nothing says light. */
export const readTheme: Effect.Effect<Theme> = Effect.sync(() =>
	window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark",
)

/** The locale and zone the timestamps are shown in, read once with the other flags. */
export const readTimeFormat: Effect.Effect<TimeFormat> = Effect.sync(() => {
	const resolved = new Intl.DateTimeFormat().resolvedOptions()
	return { locale: resolved.locale, timeZone: resolved.timeZone }
})

/** `max-md`: below 768px the sidebar is a sheet. */
export const MOBILE_QUERY = "(max-width: 767px)"

export const readIsMobile: Effect.Effect<boolean> = Effect.sync(() => window.matchMedia(MOBILE_QUERY).matches)
