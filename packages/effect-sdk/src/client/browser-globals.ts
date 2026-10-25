/**
 * Narrow optional globals for the DOM-free SDK build, which also runs in
 * Workers and Node.
 */
import { trySyncOrUndefined } from "../shared/try-sync.js"
import { SDK_VERSION } from "../version.js"

interface BrowserNavigator {
	readonly userAgent?: string
	readonly language?: string
	readonly onLine?: boolean
}

interface BrowserDocument {
	readonly visibilityState?: string
}

export const browserNavigator = (): BrowserNavigator | undefined =>
	(globalThis as { navigator?: BrowserNavigator }).navigator

export const browserDocument = (): BrowserDocument | undefined =>
	(globalThis as { document?: BrowserDocument }).document

/** Resource attributes every browser preset sends: the SDK, the user agent, language and time zone. */
export const browserResourceAttributes = () => {
	const nav = browserNavigator()
	// A locale-stripped build throws from `DateTimeFormat` rather than reporting an unknown zone.
	const timezone =
		typeof Intl === "undefined"
			? undefined
			: trySyncOrUndefined(() => Intl.DateTimeFormat().resolvedOptions().timeZone)
	return {
		// Semconv requires these of an SDK; one that is not OpenTelemetry's names its own package.
		"telemetry.sdk.name": "@maple-dev/effect-sdk",
		"telemetry.sdk.language": "webjs",
		"telemetry.sdk.version": SDK_VERSION,
		// `user_agent.original` is the semconv key; `browser.user_agent` was deprecated in favour of it.
		...(nav?.userAgent ? { "user_agent.original": nav.userAgent } : undefined),
		...(nav?.language ? { "browser.language": nav.language } : undefined),
		// Not a semconv key, so it lives under `maple.*` rather than semconv's `browser.*`.
		...(timezone ? { "maple.browser.timezone": timezone } : undefined),
	}
}
