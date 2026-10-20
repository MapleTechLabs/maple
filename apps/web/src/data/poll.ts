import { Clock, Duration, Effect, Stream } from "effect"
import { Dom } from "foldkit"

/** Whether a poll may fetch now, and the moments that may change it (the tab shown, back online). */
export interface Presence {
	readonly isPresent: () => boolean
	readonly changes: Stream.Stream<void>
}

/** A target's events, or none off the browser (tests, SSR), where `document` and `window` do not exist. */
const changesOf = (target: () => EventTarget | undefined, type: "visibilitychange" | "online"): Stream.Stream<void> =>
	Stream.unwrap(
		Effect.sync(() => {
			const resolved = target()
			return resolved === undefined
				? Stream.empty
				: Dom.streamFromEvent({ target: resolved, type, mapEvent: () => undefined })
		}),
	)

/** The tab is visible and the browser online; off the browser (tests, SSR) it always is. */
const browserPresence: Presence = {
	isPresent: () =>
		(typeof document === "undefined" || !document.hidden) &&
		(typeof navigator === "undefined" || navigator.onLine !== false),
	changes: Stream.merge(
		changesOf(() => (typeof document === "undefined" ? undefined : document), "visibilitychange"),
		changesOf(() => (typeof window === "undefined" ? undefined : window), "online"),
	),
}

/** Emits once the tab is present: at once if it is, else on the first return. */
export const whenPresent = (presence: Presence = browserPresence): Stream.Stream<void> =>
	Stream.concat(Stream.succeed(undefined), presence.changes).pipe(
		Stream.filter(() => presence.isPresent()),
		Stream.take(1),
	)

type Signal = "Tick" | "Change"

type PollState = Readonly<{ isMissed: boolean; caughtUpAtMs: number | null }>

/**
 * A poll's ticks for a Subscription: one every `every`, the first after a full interval. A tick
 * that falls while the tab is hidden or offline is skipped; the first return after one ticks at
 * once, and a regular tick within half an interval of that catch-up is dropped, so the next
 * fetch comes 0.5x to 1.5x the interval later.
 */
export const pollTicks = (every: Duration.Input, presence: Presence = browserPresence): Stream.Stream<void> => {
	const everyMs = Duration.toMillis(every)
	const next = (state: PollState, signal: Signal, nowMs: number): readonly [PollState, ReadonlyArray<void>] => {
		if (!presence.isPresent()) return [{ ...state, isMissed: state.isMissed || signal === "Tick" }, []]
		if (signal === "Change")
			return state.isMissed ? [{ isMissed: false, caughtUpAtMs: nowMs }, [undefined]] : [state, []]
		const isJustCaughtUp = state.caughtUpAtMs !== null && nowMs - state.caughtUpAtMs < everyMs / 2
		return [{ isMissed: false, caughtUpAtMs: null }, isJustCaughtUp ? [] : [undefined]]
	}
	return Stream.merge(
		Stream.tick(every).pipe(
			Stream.drop(1),
			Stream.map((): Signal => "Tick"),
		),
		Stream.map(presence.changes, (): Signal => "Change"),
	).pipe(
		Stream.mapAccumEffect(
			(): PollState => ({ isMissed: false, caughtUpAtMs: null }),
			(state, signal) => Effect.map(Clock.currentTimeMillis, (nowMs) => next(state, signal, nowMs)),
		),
	)
}
