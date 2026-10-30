import {
	claimReplayMode,
	clearPendingChunk,
	clearPendingEvents,
	clearSessionSink,
	configurePrivacy,
	getActiveSink,
	getObservedTraceIds,
	getSession,
	hasConsent,
	type IdentifyInput,
	mayPersistIdentifier,
	normalizeIdentity,
	onConsentChange,
	publishSessionSink,
	rotateSession,
	isLikelyBot,
	sdkHint,
	setActiveTraceIdProvider,
	setVisitorTracking,
	startEventSink,
	startMetadataSession,
	type MetadataSessionHandle,
	type SessionEventSink,
} from "@maple/browser-session"
// Type-only: the replay entry pulls rrweb, so it may only be reached through the
// dynamic import in `startRuntime`.
import type { ReplaySessionHandle } from "@maple/browser-session/replay"
import { trace } from "@opentelemetry/api"
import { type MapleBrowserConfig, type ResolvedConfig, resolveConfig } from "./config"
import { configureErrorFilters } from "./error-filters"
import { closeExceptionCapture, onErrorRecorded, openExceptionCapture, setupErrorCapture } from "./errors"
import { setLogIdentity } from "./logs"
import { resetNavigation } from "./navigation"
import { attachSpanStash } from "./offline"
import { setupTracing } from "./tracing"
import { SDK_NAME, SDK_VERSION } from "./version"

/** `x-maple-sdk` value for every request this build makes to ingest. */
const SDK_HINT = sdkHint(SDK_NAME, SDK_VERSION)

export interface MapleBrowserHandle {
	/**
	 * Empty until consent is granted when `requireConsent` is enabled, and while
	 * a previous `shutdown()` is still flushing.
	 */
	readonly sessionId: string
	/**
	 * Tear down tracing + session capture, flushing the final buffers. The SDK
	 * is released at once: an `init()` right after it gets a new, live handle.
	 */
	readonly shutdown: () => Promise<void>
}

interface BrowserRuntime {
	readonly initialSessionId: string
	readonly sink: SessionEventSink
	replay?: ReplaySessionHandle | undefined
	metadata?: MetadataSessionHandle | undefined
	/** Settles when the lazy replay chunk resolved; absent on the metadata path. */
	replayPending?: Promise<void> | undefined
}

let active: MapleBrowserHandle | undefined
/** What the live handle was made from, to tell a repeated `init()` from a reconfiguration. */
let activeRawConfig: MapleBrowserConfig | undefined
let warnedReinit = false
// Same object the session lifecycle's `getIdentity` reads, so `identify()`
// mutations are seen by later metadata rows.
let activeConfig: ResolvedConfig | undefined
/**
 * An `identify()` made before `init()`, applied when it runs. Auth callbacks
 * routinely resolve before the SDK is initialized; dropping the call meant the
 * whole first session went anonymous. Wrapped so a pending *clear* (`undefined`)
 * is distinguishable from no call at all.
 */
let pendingIdentity: { readonly input: IdentifyInput } | undefined
/**
 * The flushing half of every `shutdown()` still running. A new `init()` starts
 * its session and deferred signals behind it: the session sink, replay and log
 * pipeline are page-wide, and the old teardown would otherwise stop the new ones.
 */
let teardown: Promise<void> | undefined
/** The longest a new `init()` waits for the previous handle's final flush. */
const TEARDOWN_WAIT_MS = 3_000

/** Run one teardown step; a failure must not leave the rest of the SDK half torn down. */
async function attempt(step: () => Promise<void> | undefined): Promise<void> {
	try {
		await step()
	} catch {}
}

/** Same settings, by value: a re-render passing a fresh but equal object is not a reconfiguration. */
function sameConfig(a: MapleBrowserConfig, b: MapleBrowserConfig): boolean {
	if (a === b) return true
	try {
		return JSON.stringify(a) === JSON.stringify(b)
	} catch {
		return false
	}
}

/**
 * Initialize Maple browser telemetry. With consent gating enabled the returned
 * handle remains live while denied: granting starts capture, revoking detaches
 * it without flushing, and a later grant starts cleanly again. While a handle
 * is live, `init()` returns it and ignores the new config.
 */
export function init(rawConfig: MapleBrowserConfig): MapleBrowserHandle {
	if (active) {
		if (activeRawConfig && !warnedReinit && !sameConfig(activeRawConfig, rawConfig)) {
			warnedReinit = true
			console.warn(
				"[maple] init() was called again with a different config while the SDK is running; the new config is ignored. Call shutdown() on the first handle before re-initializing.",
			)
		}
		return active
	}
	if (typeof window === "undefined") {
		return { sessionId: "", shutdown: () => Promise.resolve() }
	}

	const config = resolveConfig(rawConfig)
	// Called after `init` was written, so it is the newer statement of who is here.
	if (pendingIdentity) config.identity = normalizeIdentity(pendingIdentity.input)
	pendingIdentity = undefined
	activeConfig = config
	activeRawConfig = rawConfig
	const removeSanitizer = configurePrivacy(config)
	configureErrorFilters(config.errorFilters)
	if (!hasConsent()) clearPendingEvents()
	setActiveTraceIdProvider(() => trace.getActiveSpan()?.spanContext().traceId)

	// Crawlers are excluded before the sample roll, not by it: they still get a
	// metadata-only session (Web Analytics counts them, and the server-side
	// classifier is what labels them a bot there), but no rrweb chunk and no
	// uploads. See `isLikelyBot`.
	const replayEligible = config.replayEnabled && !isLikelyBot(navigator.userAgent)
	const recordErrors = config.tracingEnabled && config.tracingCaptureErrors
	// Capped: a teardown stuck on a stalled request must not keep this handle from capturing.
	const behind =
		teardown &&
		Promise.race([teardown, new Promise<void>((resolve) => setTimeout(resolve, TEARDOWN_WAIT_MS))])
	let ready = behind === undefined
	let runtime: BrowserRuntime | undefined
	let stopped = false
	let rotateOnNextStart = false
	let shutdownTracing: (() => Promise<void>) | undefined
	let stopErrorCapture: (() => void) | undefined
	let deferredPending: Promise<void> | undefined
	let stopDeferred: (() => Promise<void>) | undefined
	// Bumped by every start and stop, so a replay chunk that lands after a
	// consent revoke (or a rotation) never attaches a recorder to a dead runtime.
	let generation = 0

	// Tracing is per-provider, and the previous one released the globals as its
	// shutdown began, so this part starts at once even behind a teardown.
	const startTelemetry = (): void => {
		if (stopped || !hasConsent()) return
		if (config.tracingEnabled && !shutdownTracing) shutdownTracing = setupTracing(config)
		// After `setupTracing`: the handlers span through the provider it
		// registers, so registering them first would drop the errors of the very
		// first moments into a no-op tracer. Without recording, they still keep a
		// buffered replay for an uncaught error.
		if (!stopErrorCapture && (recordErrors || (replayEligible && config.replayOnErrorSampleRate > 0))) {
			stopErrorCapture = setupErrorCapture(recordErrors)
		}
	}

	const startRuntime = (): void => {
		startTelemetry()
		if (stopped || !ready || runtime || !hasConsent()) return
		setVisitorTracking(config.persistVisitorId && mayPersistIdentifier())
		const session = (rotateOnNextStart ? rotateSession() : undefined) ?? getSession()
		rotateOnNextStart = false
		// Rolled once per session and persisted on it, so a reload or the next
		// page of a multi-page app records (or skips) the same session consistently.
		const replayMode = replayEligible
			? claimReplayMode(config.replaySampleRate, config.replayOnErrorSampleRate)
			: "off"
		publishSessionSink(session.id)
		const sink = startEventSink(
			{
				endpoint: config.endpoint,
				ingestKey: config.ingestKey,
				sdk: SDK_HINT,
				maskAllInputs: config.maskAllInputs,
				maskAllText: config.maskAllText,
				getIdentity: () => config.identity,
			},
			session.id,
		)
		if (!deferredPending) {
			setLogIdentity(() => config.identity?.id)
			deferredPending = import("./deferred")
				// Started even when shutdown() is already waiting on it, so queued records still flush.
				.then(({ startDeferred }) => {
					stopDeferred = startDeferred(config)
				})
				.catch(() => {
					// A blocked chunk costs the deferred signals, never the page.
				})
		}
		const shared = {
			endpoint: config.endpoint,
			ingestKey: config.ingestKey,
			sdk: SDK_HINT,
			serviceName: config.serviceName,
			environment: config.environment,
			serviceVersion: config.serviceVersion,
			getIdentity: () => config.identity,
			captureUserEmail: config.captureUserEmail,
		}
		// The replay path publishes the sink and sources trace ids itself (the
		// Effect SDK drives it with neither wired), so only the metadata path takes
		// them from here. Passing both would republish the sink twice per rotation.
		const startMetadata = (): MetadataSessionHandle | undefined =>
			startMetadataSession({
				...shared,
				getTraceIds: getObservedTraceIds,
				onSessionChange: publishSessionSink,
			})

		if (replayMode === "off") {
			runtime = { initialSessionId: session.id, sink, metadata: startMetadata() }
			return
		}

		// Sampled in: rrweb rides in a code-split chunk so the ~90% of visitors a
		// sample rate excludes never download it. The sampling decision above is
		// synchronous; only the recorder handle arrives late.
		const next: BrowserRuntime = { initialSessionId: session.id, sink }
		runtime = next
		const ownGeneration = ++generation
		const stale = (): boolean =>
			stopped || !hasConsent() || generation !== ownGeneration || runtime !== next
		next.replayPending = import("@maple/browser-session/replay")
			.then(({ startReplaySession }) => {
				if (stale()) return
				next.replay = startReplaySession({
					...shared,
					maskAllInputs: config.maskAllInputs,
					maskAllText: config.maskAllText,
					mode: replayMode,
					canvasFps: config.canvasFps,
					networkBodies: config.networkBodies,
				})
			})
			.catch(() => {
				// A blocked or failed chunk should still leave a session row behind.
				if (stale()) return
				next.metadata = startMetadata()
			})
	}

	const stopRuntime = async (flush: boolean): Promise<void> => {
		// Before the first await, so an in-flight replay chunk sees a stale
		// generation and never starts a recorder behind the teardown.
		generation++
		const previous = runtime
		runtime = undefined
		if (!previous) return
		const replayShutdown = previous.replay?.shutdown({ flush })
		const metadataShutdown = previous.metadata?.shutdown({ flush })
		const currentSessionId = previous.replay?.sessionId ?? previous.metadata?.sessionId
		const liveSink = getActiveSink()
		const sink =
			liveSink && currentSessionId && liveSink.sessionId === currentSessionId ? liveSink : previous.sink
		// The flush takes the buffer now; detaching before awaiting it sends events
		// emitted meanwhile to the pending queue, which the next sink drains.
		const flushed = flush ? sink.flush(true) : undefined
		sink.stop()
		if (sink !== previous.sink) previous.sink.stop()
		clearSessionSink(currentSessionId ?? previous.initialSessionId)
		await flushed
		// Awaiting the import too keeps `shutdown()` a real quiescence point: it
		// resolves with no replay work still scheduled behind it.
		await Promise.allSettled([replayShutdown, metadataShutdown, previous.replayPending])
	}

	// A buffered replay keeps itself the moment an error is recorded.
	const stopReplayTrigger = onErrorRecorded(() => {
		void runtime?.replay?.trigger()
	})
	startRuntime()
	openExceptionCapture()
	if (!ready) {
		// The handle is live already; its session starts once the previous one is flushed.
		void behind?.then(() => {
			ready = true
			startRuntime()
		})
	}
	// Consent is page-wide and only tightens: another SDK copy can turn the gate
	// on after this init. Without a gate the listener never fires.
	const stopConsentListener = onConsentChange((allowed) => {
		if (allowed) {
			startRuntime()
			return
		}
		rotateOnNextStart = runtime !== undefined
		clearPendingEvents()
		// Before the teardown: a flush still compressing the chunk then finds nothing to send.
		clearPendingChunk()
		setVisitorTracking(false)
		void stopRuntime(false)
	})

	const handle: MapleBrowserHandle = {
		get sessionId() {
			return (
				runtime?.replay?.sessionId ?? runtime?.metadata?.sessionId ?? runtime?.initialSessionId ?? ""
			)
		},
		shutdown: () => {
			if (stopped) return Promise.resolve()
			stopped = true
			// Everything page-wide is released synchronously, so an `init()` right
			// after this (React StrictMode, a remount) starts a live SDK.
			if (active === handle) {
				active = undefined
				activeRawConfig = undefined
				activeConfig = undefined
			}
			stopConsentListener()
			stopReplayTrigger()
			closeExceptionCapture()
			stopErrorCapture?.()
			stopErrorCapture = undefined
			configureErrorFilters(undefined)
			removeSanitizer()
			setActiveTraceIdProvider(() => undefined)
			// Before the provider shuts down, so an open navigation exports with it
			resetNavigation()
			// Both release their page-wide state before their first await.
			const runtimeStopped = stopRuntime(true)
			const tracingStopped = shutdownTracing?.()
			shutdownTracing = undefined
			const flushed = (async () => {
				await attempt(() => runtimeStopped)
				await attempt(() => deferredPending)
				// Tracing first: its last flush may fail into the offline queue, which the deferred stop closes.
				await attempt(() => tracingStopped)
				await attempt(() => stopDeferred?.())
				stopDeferred = undefined
				// Span batches held for a deferred chunk that never landed belong to this
				// session, unless a newer handle already holds its own there.
				if (active === undefined) attachSpanStash(undefined)
			})()
			const all = Promise.all([behind, flushed]).then(() => {})
			teardown = all
			void all.finally(() => {
				if (teardown === all) teardown = undefined
			})
			return all
		},
	}
	active = handle
	return handle
}

/**
 * Attach, replace, or clear the end-user identity on the active session.
 * Idempotent and safe to call on every render. Future browser-created spans
 * read the id when they start, and future session metadata rows read the whole
 * identity when they post.
 *
 * Accepts a bare user id or the full object:
 *
 * ```ts
 * MapleBrowser.identify("user_123")
 * MapleBrowser.identify({ id: "user_123", email: "a@b.com", groupId: "org_1", groupName: "Acme" })
 * ```
 *
 * Each call replaces the identity rather than merging — merging would leak a
 * signed-out user's email into whoever signs in next on a shared device.
 *
 * Safe before `init()`: the latest call is held and applied when `init()` runs,
 * taking precedence over the `user` passed to it.
 */
export function identify(input?: IdentifyInput): void {
	if (typeof window === "undefined") return
	if (!activeConfig) {
		pendingIdentity = { input }
		return
	}
	activeConfig.identity = normalizeIdentity(input)
}
