// Main-thread jank as spans: long animation frames (with the script that ran
// longest) and slow interactions (split into input delay, processing and
// presentation). Opt-in; nested under the open navigation when there is one.
import { hasConsent, scrubUrl, selectorOf } from "@maple/browser-session"
import { context, trace } from "@opentelemetry/api"
import { navigationSpanAt } from "../navigation"
import { liveMapleTracer } from "../tracing"
import { SDK_NAME, SDK_VERSION } from "../version"

/** A frame this long is visible jank; the Long Animation Frames API reports from 50ms. */
const LONG_FRAME_MS = 100
/** INP's "needs improvement" line. */
const SLOW_INTERACTION_MS = 200

export interface PerfOptions {
	readonly longFrames: boolean
	readonly slowInteractions: boolean
}

interface ScriptTiming {
	readonly duration: number
	readonly invoker?: string
	readonly sourceURL?: string
	readonly sourceFunctionName?: string
}

const epoch = (offset: number): number => performance.timeOrigin + offset

function span(
	name: string,
	start: number,
	duration: number,
	attributes: Record<string, string | number>,
): void {
	const tracer = hasConsent() ? liveMapleTracer(SDK_NAME, SDK_VERSION) : undefined
	if (!tracer) return
	// Buffered entries can predate the open navigation: those stay roots.
	const navigation = navigationSpanAt(epoch(start))
	const parent = navigation ? trace.setSpan(context.active(), navigation) : context.active()
	tracer.startSpan(name, { startTime: epoch(start), attributes }, parent).end(epoch(start + duration))
}

function scriptsOf(entry: PerformanceEntry): ScriptTiming[] {
	const scripts: unknown = "scripts" in entry ? entry.scripts : undefined
	if (!Array.isArray(scripts)) return []
	return scripts.flatMap((script: unknown): ScriptTiming[] => {
		if (typeof script !== "object" || script === null || !("duration" in script)) return []
		if (typeof script.duration !== "number") return []
		// `in` and property reads walk the prototype, where PerformanceScriptTiming keeps these getters.
		const invoker: unknown = "invoker" in script ? script.invoker : undefined
		const sourceURL: unknown = "sourceURL" in script ? script.sourceURL : undefined
		const sourceFunctionName: unknown =
			"sourceFunctionName" in script ? script.sourceFunctionName : undefined
		return [
			{
				duration: script.duration,
				invoker: typeof invoker === "string" && invoker !== "" ? invoker : undefined,
				sourceURL: typeof sourceURL === "string" && sourceURL !== "" ? sourceURL : undefined,
				sourceFunctionName:
					typeof sourceFunctionName === "string" && sourceFunctionName !== ""
						? sourceFunctionName
						: undefined,
			},
		]
	})
}

/** Exported for tests: headless Chromium lists LoAF as supported but never renders a frame to report. */
export function onLongFrame(entry: PerformanceEntry): void {
	if (entry.duration < LONG_FRAME_MS) return
	const blocking =
		"blockingDuration" in entry && typeof entry.blockingDuration === "number"
			? entry.blockingDuration
			: undefined
	const longest = scriptsOf(entry).sort((a, b) => b.duration - a.duration)[0]
	span(
		entry.entryType === "longtask" ? "longtask" : "longAnimationFrame",
		entry.startTime,
		entry.duration,
		{
			...(blocking !== undefined
				? { "maple.browser.frame.blocking_duration_ms": Math.round(blocking) }
				: undefined),
			...(longest?.sourceURL ? { "code.file.path": scrubUrl(longest.sourceURL) } : undefined),
			...(longest?.sourceFunctionName
				? { "code.function.name": longest.sourceFunctionName }
				: undefined),
			...(longest?.invoker ? { "maple.browser.script.invoker": longest.invoker } : undefined),
			...(longest ? { "maple.browser.script.duration_ms": Math.round(longest.duration) } : undefined),
		},
	)
}

function observe(
	type: string,
	onEntries: (entries: PerformanceEntryList) => void,
	options: Record<string, number> = {},
): () => void {
	if (
		typeof PerformanceObserver === "undefined" ||
		!PerformanceObserver.supportedEntryTypes?.includes(type)
	) {
		return () => {}
	}
	const observer = new PerformanceObserver((list) => onEntries(list.getEntries()))
	// Buffered: what happened before this chunk loaded is reported too.
	observer.observe({ type, buffered: true, ...options })
	return () => observer.disconnect()
}

const processingOf = (entry: PerformanceEventTiming): number => entry.processingEnd - entry.processingStart

/**
 * The interaction an event belongs to. `0` means "not an interaction"; an engine
 * without `interactionId` gets a per-event key, so its slow events are still spanned.
 */
export function interactionKey(entry: {
	readonly interactionId?: number
	readonly name: string
	readonly startTime: number
}): string | undefined {
	const id = entry.interactionId
	if (id === 0) return undefined
	return id === undefined ? `${entry.name}:${Math.round(entry.startTime)}` : `id:${id}`
}

function spanInteraction(entry: PerformanceEventTiming): void {
	span(`interaction ${entry.name}`, entry.startTime, entry.duration, {
		"maple.browser.interaction.input_delay_ms": Math.round(entry.processingStart - entry.startTime),
		"maple.browser.interaction.processing_ms": Math.round(processingOf(entry)),
		"maple.browser.interaction.presentation_ms": Math.round(
			entry.startTime + entry.duration - entry.processingEnd,
		),
		...(entry.target instanceof Element
			? { "maple.browser.interaction.target": selectorOf(entry.target) }
			: undefined),
	})
}

export function startPerf(options: PerfOptions): () => void {
	const stops: Array<() => void> = []
	if (options.longFrames) {
		const hasLoaf =
			typeof PerformanceObserver !== "undefined" &&
			PerformanceObserver.supportedEntryTypes?.includes("long-animation-frame") === true
		stops.push(
			observe(hasLoaf ? "long-animation-frame" : "longtask", (entries) => {
				for (const entry of entries) onLongFrame(entry)
			}),
		)
	}
	if (options.slowInteractions) {
		const seen = new Set<string>()
		stops.push(
			observe(
				"event",
				(entries) => {
					// One interaction fires several events (pointerdown, pointerup, click): span it
					// once, named after the event whose handlers ran longest.
					const byInteraction = new Map<string, PerformanceEventTiming>()
					for (const entry of entries) {
						if (!(entry instanceof PerformanceEventTiming)) continue
						const key = interactionKey(entry)
						if (key === undefined || entry.duration < SLOW_INTERACTION_MS || seen.has(key))
							continue
						const best = byInteraction.get(key)
						if (!best || processingOf(entry) > processingOf(best)) byInteraction.set(key, entry)
					}
					for (const [id, entry] of byInteraction) {
						seen.add(id)
						spanInteraction(entry)
					}
					if (seen.size > 500) seen.clear()
				},
				{ durationThreshold: SLOW_INTERACTION_MS },
			),
		)
	}
	return () => {
		for (const stop of stops) stop()
	}
}
