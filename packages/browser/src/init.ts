import { type MapleBrowserConfig, type ResolvedConfig, formatCHDateTime, resolveConfig } from "./config"
import { getSession, parseUserAgent } from "./session"
import { setupTracing } from "./tracing"
import { getObservedTraceIds, publishSessionSink } from "./session-sink"
import { startRecording, type Recorder } from "./replay/record"
import { startEventCapture, type EventCapture } from "./replay/events"
import { postSessionMeta } from "./replay/transport"

export interface MapleBrowserHandle {
	readonly sessionId: string
	/** Tear down tracing + replay (flushing the final chunk). */
	readonly shutdown: () => Promise<void>
}

let active: MapleBrowserHandle | undefined

/**
 * Initialize Maple browser telemetry: OTel tracing + (sampled) rrweb session
 * replay, both tagged with one shared session id so a trace can link to its
 * replay and vice versa. Idempotent — repeated calls return the live handle.
 */
export function init(rawConfig: MapleBrowserConfig): MapleBrowserHandle {
	if (active) return active
	if (typeof window === "undefined") {
		// SSR / non-browser: no-op handle so isomorphic apps can call init freely.
		return { sessionId: "", shutdown: () => Promise.resolve() }
	}

	const config = resolveConfig(rawConfig)
	// One bounded session per activity window: reused across reloads (so traces
	// and replay chunks correlate), rotated once idle. `startedAt` comes from the
	// record so `duration_ms` reflects the whole session, not just this page load.
	const session = getSession()
	const sessionId = session.id
	const startedAt = new Date(session.startedAt)

	// Publish first so external tracers (Effect client SDK) can feed trace ids
	// into this session regardless of init ordering.
	publishSessionSink(sessionId)

	const shutdownTracing = config.tracingEnabled ? setupTracing(config, sessionId) : undefined

	const recordReplay = config.replayEnabled && Math.random() < config.replaySampleRate
	let recorder: Recorder | undefined
	let events: EventCapture | undefined
	if (recordReplay) {
		recorder = startRecording(config, sessionId)
		// Distilled events (console/network/error/nav/clicks) ride the same
		// sampling decision as the rrweb recording.
		events = startEventCapture(config, sessionId)
		void postSessionMeta(config, sessionMetaRow(config, sessionId, startedAt, 1, "active", null))
		installLifecycleHandlers(config, sessionId, startedAt, recorder, events)
	}

	const handle: MapleBrowserHandle = {
		sessionId,
		shutdown: async () => {
			if (recorder) await recorder.flush(true)
			if (events) await events.flush(true)
			events?.stop()
			await shutdownTracing?.()
			active = undefined
		},
	}
	active = handle
	return handle
}

function installLifecycleHandlers(
	config: ResolvedConfig,
	sessionId: string,
	startedAt: Date,
	recorder: Recorder,
	events: EventCapture,
): void {
	let finalized = false
	const finalize = () => {
		if (finalized) return
		finalized = true
		// keepalive flush survives unload; the ended-metadata row carries the
		// observed trace ids for trace↔replay correlation.
		void recorder.flush(true)
		void events.flush(true)
		void postSessionMeta(
			config,
			sessionMetaRow(config, sessionId, startedAt, 2, "ended", recorder.getClickCount()),
			true,
		)
	}
	// `visibilitychange → hidden` is the reliable "leaving" signal on mobile;
	// pagehide covers desktop tab close / navigation.
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") finalize()
	})
	window.addEventListener("pagehide", finalize)
}

function sessionMetaRow(
	config: ResolvedConfig,
	sessionId: string,
	startedAt: Date,
	version: number,
	status: "active" | "ended",
	clickCount: number | null,
): Record<string, unknown> {
	const ua = parseUserAgent(navigator.userAgent)
	const now = new Date()
	const row: Record<string, unknown> = {
		session_id: sessionId,
		start_time: formatCHDateTime(startedAt),
		status,
		version,
		user_id: config.userId ?? "",
		url_initial: window.location.href,
		user_agent: navigator.userAgent,
		browser_name: ua.browserName,
		os_name: ua.osName,
		device_type: ua.deviceType,
		service_name: config.serviceName,
		resource_attributes: config.environment
			? {
					// Dual-emit: legacy key (pre-extracted by Tinybird MVs) + canonical.
					"deployment.environment": config.environment,
					"deployment.environment.name": config.environment,
				}
			: {},
	}
	if (status === "ended") {
		row.end_time = formatCHDateTime(now)
		row.duration_ms = Math.max(0, now.getTime() - startedAt.getTime())
		row.click_count = clickCount ?? 0
		row.trace_ids = getObservedTraceIds()
	}
	return row
}
