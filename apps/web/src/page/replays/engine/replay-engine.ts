// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
// The replay engine seam. The iOS SDK records H.264 segments and wraps each one in rrweb-shaped
// events so the chunk pipeline carries them untouched, but there is no DOM to rebuild, so rrweb
// renders nothing. Everything above this interface (transport, timeline, markers, idle bands, chunk
// loader) is format-agnostic; rrweb lives in `rrweb-engine.ts`, video in `video-engine.ts`.

/** The recorded viewport, used to letterbox the recording inside the surface. */
export interface Viewport {
	readonly width: number
	readonly height: number
}

export interface ReplayEngineCreateInput {
	/** The surface's inner div. The engine owns its contents entirely. */
	readonly mount: HTMLElement
	/** The seed events. Later events arrive through `addEvent`, forward-only. */
	readonly events: ReadonlyArray<unknown>
	/** Viewport to fall back to when the engine can't report its own, from `deriveMeta`. */
	readonly fallbackViewport: Viewport
	/** Playback reached the end of the recording. */
	onFinish(): void
	/** The recorded viewport changed mid-session; the surface must re-fit. */
	onResize(): void
}

export interface ReplayEngine {
	/** Length of the loaded recording, in real ms. */
	readonly totalTimeMs: number
	/**
	 * Playhead as a real-ms offset from session start, matching the clock the
	 * trimmed `Timeline` and backend span alignment are built against.
	 *
	 * Implementations must never return a negative or non-finite value: the
	 * provider feeds this straight back into `play()`.
	 */
	getCurrentTimeMs(): number
	play(offsetMs: number): void
	/** With no offset, hold at the current position. */
	pause(offsetMs?: number): void
	setSpeed(speed: number): void
	/**
	 * Append an event that arrived after construction.
	 *
	 * Forward-only by contract: every trailing event postdates the seed. A
	 * backward seek rebuilds the engine from the nearest checkpoint instead
	 * (see `requestSeek` in `detail/loader.ts`).
	 */
	addEvent(event: unknown): void
	/** Fit the recording inside `container`, letterboxed and centred. */
	fit(container: HTMLElement): void
	destroy(): void
}

export interface ReplayEngineFactory {
	create(input: ReplayEngineCreateInput): ReplayEngine
}
