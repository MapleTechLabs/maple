import { type IdentifyInput, setConsent, type TrackProps, track } from "@maple/browser-session"
import type { MapleBrowserConfig } from "./config"
import { type CaptureExceptionOptions, captureException } from "./errors"
import { identify, init, type MapleBrowserHandle } from "./init"
import { endNavigation, startNavigation, type TracedOptions, traced } from "./navigation"

export type {
	IdentifyInput,
	MapleIdentity,
	MapleRegion,
	TrackProps,
	TraitValue,
} from "@maple/browser-session"
export type { MapleBrowserConfig } from "./config"
export type { CaptureExceptionOptions } from "./errors"
export type { MapleBrowserHandle } from "./init"
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
	/**
	 * Call when the router starts a navigation, with the concrete path. The
	 * first call opens a `pageload` span, joined to the server render's trace
	 * when the document response carried a `Server-Timing: traceparent;desc="…"`
	 * entry or the page a `<meta name="traceparent">` tag. Later calls open
	 * `navigate` spans. A navigation still open is ended with
	 * `app.navigation.interrupted: true`. Spans nothing until tracing is live
	 * (after `init()`, with consent), but the first call in the page still
	 * counts as the page load. No-op on the server.
	 */
	startNavigation: (path: string) => void
	/**
	 * Call when the new route is ready. `route` is its template, like
	 * `/projects/:id` (never the concrete URL): the span is renamed, like
	 * `navigate /projects/:id`, and ended. No-op when no navigation is open.
	 */
	endNavigation: (route?: string) => void
	/**
	 * Run route-level data loading in a span under the open navigation (or the
	 * active context when none is open), named like `loader /projects/:id`.
	 * Requests `fn` starts before its first `await` are children of the span;
	 * the browser has no async context, so later ones are not.
	 *
	 * A throw is recorded on the span and marks it Error, unless
	 * `options.isFailure` returns `false` for it (redirects, not-found). An
	 * error recorded here is not reported again by `captureException` or the
	 * global handlers. `fn`'s result and error pass through unchanged; without
	 * live tracing, `fn` just runs.
	 */
	traced: <T>(name: string, fn: () => Promise<T>, options?: TracedOptions) => Promise<T>
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
}
