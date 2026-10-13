// Configuration groups both SDKs accept with the same names, defaults and
// meaning. Each SDK's config extends these; `resolveSignalOptions` is the one
// place the defaults live.
import type { ErrorFilterOptions } from "./error-filters"
import { type HeaderCapture, type HeaderCaptureOptions, resolveHeaderCapture } from "./http-headers"
import { resolveSampleRate } from "./sampling"

export type ConsoleLevel = "debug" | "log" | "info" | "warn" | "error"

export interface TracingSignalOptions {
	/**
	 * Fraction of sessions whose traces are exported, 0–1. Default 1. Decided
	 * once per session, so a sampled session keeps every trace. Error spans are
	 * always exported.
	 */
	readonly sampleRate?: number
	/**
	 * Request and response headers to record on HTTP client spans, as
	 * `http.request.header.<name>` / `http.response.header.<name>`. Default none.
	 * Credential headers (`authorization`, `cookie`, `set-cookie`, ...) are never recorded.
	 */
	readonly captureHeaders?: HeaderCaptureOptions
	/** Span main-thread frames of 100ms or more. Default false. */
	readonly longFrames?: boolean
	/** Span interactions of 200ms or more, split into input delay, processing and presentation. Default false. */
	readonly slowInteractions?: boolean
}

export interface ReplayOptions {
	/** Record session replays. Default true. */
	readonly enabled?: boolean
	/** Fraction of sessions to record, 0–1. Default 1. */
	readonly sampleRate?: number
	/**
	 * Fraction of the sessions not recorded that keep the last minute in memory,
	 * and upload it and record the rest of the session only if an error happens.
	 * 0–1, default 0.
	 */
	readonly onErrorSampleRate?: number
	/**
	 * Record `<canvas>` content at this many frames per second. Off by default,
	 * and never with `maskAllText`: canvas pixels can hold text.
	 */
	readonly canvasFps?: number
	/**
	 * Keep text bodies on the replay's network events for these full URLs, cut to
	 * `maxLength` characters (at most and by default 1,000). Nothing with
	 * `maskAllText`; request bodies only with `maskAllInputs` off.
	 */
	readonly networkBodies?: {
		readonly urls: ReadonlyArray<string | RegExp>
		readonly maxLength?: number
	}
}

/** The signal options shared verbatim by `MapleBrowser.init` and the Effect client presets. */
export interface SignalOptions {
	readonly tracing?: TracingSignalOptions
	/** Which captured errors to drop, and which HTTP statuses count as errors. */
	readonly errors?: ErrorFilterOptions
	/** Report Core Web Vitals as `browser.web_vital` log events. Default true. */
	readonly webVitals?: boolean
	/** Keep the last clicks, inputs, navigations and console lines, and export them with the next error. Default true. */
	readonly breadcrumbs?: boolean
	readonly logs?: {
		/** Console levels exported as logs as they happen, e.g. `["warn", "error"]`. Default none. */
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
		 * Keep batches that could not be sent in IndexedDB for up to 24 hours and
		 * send them once the browser is back online or on the next page load. Default false.
		 */
		readonly offline?: boolean
	}
}

export interface ResolvedSignalOptions {
	readonly tracingSampleRate: number
	readonly captureHeaders: HeaderCapture
	readonly longFrames: boolean
	readonly slowInteractions: boolean
	readonly errorFilters: ErrorFilterOptions
	readonly webVitals: boolean
	readonly breadcrumbs: boolean
	readonly captureConsole: ReadonlyArray<ConsoleLevel>
	readonly reportCsp: boolean
	readonly reportBrowser: boolean
	readonly offlineQueue: boolean
}

export function resolveSignalOptions(options: SignalOptions): ResolvedSignalOptions {
	return {
		tracingSampleRate: resolveSampleRate("tracing.sampleRate", options.tracing?.sampleRate),
		captureHeaders: resolveHeaderCapture(options.tracing?.captureHeaders),
		longFrames: options.tracing?.longFrames ?? false,
		slowInteractions: options.tracing?.slowInteractions ?? false,
		errorFilters: options.errors ?? {},
		webVitals: options.webVitals ?? true,
		breadcrumbs: options.breadcrumbs ?? true,
		captureConsole: options.logs?.captureConsole ?? [],
		reportCsp: options.reporting?.csp ?? true,
		reportBrowser: options.reporting?.browserReports ?? false,
		offlineQueue: options.transport?.offline ?? false,
	}
}

/** Ingest keeps 1,024 bytes of a session-event attribute; this leaves room for the cut marker. */
const MAX_BODY_LENGTH = 1_000

export interface ResolvedReplayOptions {
	readonly enabled: boolean
	readonly sampleRate: number
	readonly onErrorSampleRate: number
	readonly canvasFps: number | undefined
	readonly networkBodies:
		| { readonly urls: ReadonlyArray<string | RegExp>; readonly maxLength: number }
		| undefined
}

export function resolveReplayOptions(replay: ReplayOptions | undefined): ResolvedReplayOptions {
	return {
		enabled: replay?.enabled ?? true,
		sampleRate: resolveSampleRate("replay.sampleRate", replay?.sampleRate),
		onErrorSampleRate: resolveSampleRate("replay.onErrorSampleRate", replay?.onErrorSampleRate, 0),
		canvasFps: replay?.canvasFps,
		networkBodies: replay?.networkBodies?.urls.length
			? {
					urls: replay.networkBodies.urls,
					maxLength: Math.min(MAX_BODY_LENGTH, replay.networkBodies.maxLength ?? MAX_BODY_LENGTH),
				}
			: undefined,
	}
}
