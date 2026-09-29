import { type IdentifyInput, setConsent, type TrackProps, track } from "@maple/browser-session"
import type { MapleBrowserConfig } from "./config"
import { type CaptureExceptionOptions, captureException } from "./errors"
import { identify, init, type MapleBrowserHandle } from "./init"
import { type MapleLogger, logger } from "./logger"
import { endNavigation, startNavigation, type TracedOptions, traced } from "./navigation"

export type {
	IdentifyInput,
	MapleIdentity,
	MapleRegion,
	TrackProps,
	TraitValue,
} from "@maple/browser-session"
export type { ConsoleLevel, MapleBrowserConfig } from "./config"
export type { ErrorFilterHint, ErrorFilterOptions, ErrorSource } from "./error-filters"
export type { CaptureExceptionOptions } from "./errors"
export type { MapleBrowserHandle } from "./init"
export type { LogAttributeValue } from "./logs"
export type { MapleLogger } from "./logger"
export type { TracedOptions } from "./navigation"

/** The `MapleBrowser` namespace object. */
export interface MapleBrowserApi {
	init: (config: MapleBrowserConfig) => MapleBrowserHandle
	/**
	 * Attach, replace, or clear the end-user identity on the active session.
	 * Accepts a bare user id or the full identity object. Safe to call repeatedly,
	 * and before `init` (the latest call is applied when `init` runs).
	 */
	identify: (input?: IdentifyInput) => void
	/**
	 * Record a custom product event against the active session. Safe to call
	 * before `init` — events are queued (capped) and drained once the session
	 * starts.
	 */
	track: (name: string, props?: TrackProps) => void
	/**
	 * Report an error your app already caught — the case the global handlers
	 * cannot see, because catching it is what stops it reaching them. A
	 * framework error boundary is the canonical caller. The same error object
	 * is recorded once, even if it is rethrown afterwards.
	 *
	 * BOUNDARY: a thrown value is unparsed by definition — JavaScript can throw
	 * anything. `captureException` narrows it before it reaches a span.
	 */
	captureException: (error: unknown, options?: CaptureExceptionOptions) => void
	/** Grant or revoke consent when `privacy.requireConsent` is on. */
	setConsent: (granted: boolean) => void
	/** Call when a route change starts, with the new path. The first call in a page is the page load. */
	startNavigation: (path: string) => void
	/** Call when the new route is ready, with its route pattern (`/projects/:id`), not the URL. */
	endNavigation: (route?: string) => void
	/**
	 * Run data loading, like a route loader, in a span under the current navigation.
	 * Errors are recorded once and rethrown. Only requests started before `fn`'s first `await` nest under the span.
	 */
	traced: <T>(name: string, fn: () => Promise<T>, options?: TracedOptions) => Promise<T>
	/**
	 * Structured logs, exported as OpenTelemetry log records linked to the active
	 * span and the session. Safe before `init`: records queue until it runs.
	 */
	logger: MapleLogger
}

/**
 * Maple browser SDK. One call wires up OpenTelemetry tracing and rrweb session
 * replay, both tagged with a shared session id.
 *
 * @example
 * ```ts
 * import { MapleBrowser } from "@maple-dev/browser"
 *
 * MapleBrowser.init({
 *   ingestKey: "maple_pk_...",
 *   serviceName: "acme-web",
 *   region: "eu", // omit for the US region
 * })
 *
 * MapleBrowser.identify({ id: user.id, email: user.email, groupId: org.id, groupName: org.name })
 * MapleBrowser.track("checkout_completed", { plan: "pro", seats: 5 })
 * ```
 */
export const MapleBrowser: MapleBrowserApi = {
	init,
	identify,
	track,
	captureException,
	setConsent,
	startNavigation,
	endNavigation,
	traced,
	logger,
}
