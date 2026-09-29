import {
	type IdentifyInput,
	type MapleIdentity,
	type MapleRegion,
	normalizeIdentity,
	type ResolvedIdentity,
	resolveIngestEndpoint,
	warnIfKeylessMapleIngest,
} from "@maple/browser-session"
import type { ErrorFilterOptions } from "./error-filters"

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error"

/** Public configuration for `MapleBrowser.init`. */
export interface MapleBrowserConfig {
	/**
	 * Public ingest key (`maple_pk_...`), sent as `Authorization: Bearer …` and
	 * nothing else. Leave it unset when a proxy at `endpoint` adds auth: tracing
	 * and replay still run, sending without the header.
	 */
	readonly ingestKey?: string
	/** Service name reported on traces and stored on replay sessions. */
	readonly serviceName: string
	/**
	 * Region your Maple organization lives in: `"us"` (default,
	 * `https://ingest.maple.dev`) or `"eu"` (`https://ingest.eu.maple.dev`).
	 * Ingest keys belong to one region. Ignored when `endpoint` is set.
	 */
	readonly region?: MapleRegion
	/** Maple ingest base URL. Overrides `region`; use it for a proxy or self-hosted ingest. */
	readonly endpoint?: string
	/**
	 * Logical group this service belongs to, emitted as the OTel
	 * `service.namespace` resource attribute on traces. Optional.
	 */
	readonly serviceNamespace?: string
	/** Service version / commit SHA. */
	readonly serviceVersion?: string
	/** Deployment environment, e.g. "production". */
	readonly environment?: string
	/**
	 * Optional user id attached to replay sessions and future browser spans.
	 *
	 * @deprecated Pass `user` instead — it carries email, name, and the
	 * company/team grouping the Sessions UI can filter by.
	 */
	readonly userId?: string | null | undefined
	/** End-user identity attached to sessions and browser spans. */
	readonly user?: MapleIdentity | undefined
	readonly tracing?: {
		/** Default true. */
		readonly enabled?: boolean
		/**
		 * Auto-instrument `fetch()` to create network spans. Default true. Set
		 * false when another tracer (e.g. the Effect client SDK) already
		 * instruments requests — those spans feed the session via the published
		 * sink, and disabling this avoids redundant duplicate network spans.
		 */
		readonly instrumentFetch?: boolean
		/**
		 * Auto-instrument `XMLHttpRequest` (axios and older clients) the same way.
		 * Default true. Turn it off for the same reason as `instrumentFetch`.
		 */
		readonly instrumentXhr?: boolean
		/**
		 * Capture uncaught errors and unhandled promise rejections as error
		 * spans. Default true. Turn off only when another tracker already owns
		 * the page's global error handlers, or the same crash lands twice.
		 */
		readonly captureErrors?: boolean
		/**
		 * Cross-origin URLs whose `fetch()` requests carry the W3C `traceparent`
		 * header, so the browser span and your backend's span join one trace.
		 * Same-origin requests always carry it. Your API must allow the
		 * `traceparent` header in CORS. Example: `[/^https:\/\/api\.example\.com\//]`.
		 */
		readonly propagateTraceHeaderCorsUrls?: ReadonlyArray<string | RegExp>
		/**
		 * Fraction of sessions whose traces are exported, 0–1. Default 1. Decided
		 * once per session, so a sampled session keeps every trace. Error spans are
		 * always exported.
		 */
		readonly sampleRate?: number
	}
	/**
	 * Report Core Web Vitals (LCP, CLS, INP, FCP, TTFB) as `browser.web_vital`
	 * log events. Default true.
	 */
	readonly webVitals?: boolean
	/**
	 * Keep the last clicks, inputs, navigations and console lines in memory, and
	 * export them as logs linked to the error when one is recorded. Default true.
	 */
	readonly breadcrumbs?: boolean
	readonly logs?: {
		/** Console levels exported as OTel logs as they happen, e.g. `["warn", "error"]`. Default none. */
		readonly captureConsole?: ReadonlyArray<ConsoleLevel>
	}
	readonly reporting?: {
		/** Content Security Policy violations as `maple.browser.csp_violation` WARN logs. Default true. */
		readonly csp?: boolean
		/** Browser deprecation and intervention reports as `maple.browser.report` WARN logs. Default false. */
		readonly browserReports?: boolean
	}
	readonly transport?: {
		/**
		 * Keep span and log batches that could not be sent (the browser was
		 * offline) in IndexedDB for up to 24 hours, and send them once it is back
		 * online or on the next page load. Default false.
		 */
		readonly offline?: boolean
	}
	/** Which captured errors to drop before they are reported. See `ErrorFilterOptions`. */
	readonly errors?: ErrorFilterOptions
	readonly replay?: {
		/** Default true. */
		readonly enabled?: boolean
		/** Fraction of sessions to record, 0–1. Default 1. */
		readonly sampleRate?: number
		/**
		 * Fraction of the sessions not recorded that keep the last minute in
		 * memory, and upload it and record the rest of the session only if an
		 * error happens. 0–1, default 0.
		 */
		readonly onErrorSampleRate?: number
	}
	readonly privacy?: {
		/** Mask all `<input>` values. Default true. */
		readonly maskAllInputs?: boolean
		/**
		 * Mask all text in the rrweb recording and omit captured click target
		 * text from session events. Default false.
		 */
		readonly maskAllText?: boolean
		/**
		 * Store a persistent visitor id (localStorage) so unique visitors and
		 * new-vs-returning are measurable. Default true. Turning it off also
		 * purges any id already stored.
		 */
		readonly persistVisitorId?: boolean
		/**
		 * Scope the visitor-id cookie to the registered domain, so a marketing site
		 * and an app on sibling subdomains (`example.com` and `app.example.com`)
		 * resolve to the same visitor and a pre-signup visit links to the account it
		 * becomes. Default true. Set false to keep the cookie host-only.
		 */
		readonly crossSubdomainCookie?: boolean
		/**
		 * Explicit cookie `Domain=` (no leading dot), e.g. `"example.com"`. Defaults
		 * to the broadest domain the browser accepts, discovered by probing. `""`
		 * forces a host-only cookie.
		 */
		readonly cookieDomain?: string
		/** Capture nothing until `MapleBrowser.setConsent(true)`. Default false. */
		readonly requireConsent?: boolean
		/** Send `identify()`'s email to the warehouse. Default true. */
		readonly captureUserEmail?: boolean
		/** Treat `navigator.doNotTrack` like Global Privacy Control. Default false. */
		readonly respectDoNotTrack?: boolean
		/**
		 * Rewrite every URL before it leaves the page: session entry and exit
		 * URLs, event rows, network events, replay meta events, and span
		 * attributes. Runs after the built-in redaction, which already replaces
		 * the values of credential-shaped query and fragment parameters
		 * (`token`, `code`, `access_token`, `password`, …).
		 */
		readonly sanitizeUrl?: (url: string) => string
	}
}

export interface ResolvedConfig {
	readonly ingestKey: string | undefined
	readonly serviceName: string
	readonly endpoint: string
	readonly serviceNamespace: string | undefined
	readonly serviceVersion: string | undefined
	readonly environment: string | undefined
	/** Mutable: `MapleBrowser.identify()` can attach/replace/clear the identity after init. */
	identity: ResolvedIdentity | undefined
	readonly tracingEnabled: boolean
	readonly tracingInstrumentFetch: boolean
	readonly tracingInstrumentXhr: boolean
	readonly tracingCaptureErrors: boolean
	readonly propagateTraceHeaderCorsUrls: ReadonlyArray<string | RegExp>
	readonly tracingSampleRate: number
	readonly errorFilters: ErrorFilterOptions
	readonly webVitals: boolean
	readonly breadcrumbs: boolean
	readonly captureConsole: ReadonlyArray<ConsoleLevel>
	readonly reportCsp: boolean
	readonly reportBrowser: boolean
	readonly offlineQueue: boolean
	readonly replayEnabled: boolean
	readonly replaySampleRate: number
	readonly replayOnErrorSampleRate: number
	readonly maskAllInputs: boolean
	readonly maskAllText: boolean
	readonly persistVisitorId: boolean
	readonly crossSubdomainCookie: boolean
	readonly cookieDomain: string | undefined
	readonly requireConsent: boolean
	readonly captureUserEmail: boolean
	readonly respectDoNotTrack: boolean
	readonly sanitizeUrl: ((url: string) => string) | undefined
}

/**
 * Resolve the identity from either the new `user` object or the legacy
 * `userId` string. `user` wins when both are set.
 */
export function resolveIdentity(config: {
	readonly user?: MapleIdentity | undefined
	readonly userId?: string | null | undefined
}): ResolvedIdentity | undefined {
	return normalizeIdentity((config.user ?? config.userId) as IdentifyInput)
}

/**
 * A sample rate outside 0–1 (or not a number) is a typo, not a policy. Clamp it
 * and say so, rather than recording everyone or no one without a word.
 */
function resolveSampleRate(option: string, raw: number | undefined): number {
	if (raw === undefined) return 1
	if (typeof raw !== "number" || Number.isNaN(raw)) {
		console.warn(`[maple] ${option} must be a number between 0 and 1; got ${String(raw)}. Using 1.`)
		return 1
	}
	if (raw < 0 || raw > 1) {
		const clamped = Math.min(1, Math.max(0, raw))
		console.warn(`[maple] ${option} must be between 0 and 1; got ${raw}. Using ${clamped}.`)
		return clamped
	}
	return raw
}

export function resolveConfig(config: MapleBrowserConfig): ResolvedConfig {
	const endpoint = resolveIngestEndpoint({ endpoints: [config.endpoint], regions: [config.region] })
	warnIfKeylessMapleIngest({
		logPrefix: "[maple]",
		endpoint,
		hasIngestKey: Boolean(config.ingestKey),
		hint: "Pass `ingestKey`, or point `endpoint` at a proxy that adds it.",
	})
	return {
		ingestKey: config.ingestKey,
		serviceName: config.serviceName,
		endpoint,
		serviceNamespace: config.serviceNamespace,
		serviceVersion: config.serviceVersion,
		environment: config.environment,
		identity: resolveIdentity(config),
		tracingEnabled: config.tracing?.enabled ?? true,
		tracingInstrumentFetch: config.tracing?.instrumentFetch ?? true,
		tracingInstrumentXhr: config.tracing?.instrumentXhr ?? true,
		tracingCaptureErrors: config.tracing?.captureErrors ?? true,
		propagateTraceHeaderCorsUrls: config.tracing?.propagateTraceHeaderCorsUrls ?? [],
		tracingSampleRate: resolveSampleRate("tracing.sampleRate", config.tracing?.sampleRate),
		errorFilters: config.errors ?? {},
		webVitals: config.webVitals ?? true,
		breadcrumbs: config.breadcrumbs ?? true,
		captureConsole: config.logs?.captureConsole ?? [],
		reportCsp: config.reporting?.csp ?? true,
		reportBrowser: config.reporting?.browserReports ?? false,
		offlineQueue: config.transport?.offline ?? false,
		replayEnabled: config.replay?.enabled ?? true,
		replaySampleRate: resolveSampleRate("replay.sampleRate", config.replay?.sampleRate),
		replayOnErrorSampleRate:
			config.replay?.onErrorSampleRate === undefined
				? 0
				: resolveSampleRate("replay.onErrorSampleRate", config.replay.onErrorSampleRate),
		maskAllInputs: config.privacy?.maskAllInputs ?? true,
		maskAllText: config.privacy?.maskAllText ?? false,
		persistVisitorId: config.privacy?.persistVisitorId ?? true,
		crossSubdomainCookie: config.privacy?.crossSubdomainCookie ?? true,
		cookieDomain: config.privacy?.cookieDomain,
		requireConsent: config.privacy?.requireConsent ?? false,
		captureUserEmail: config.privacy?.captureUserEmail ?? true,
		respectDoNotTrack: config.privacy?.respectDoNotTrack ?? false,
		sanitizeUrl: config.privacy?.sanitizeUrl,
	}
}
