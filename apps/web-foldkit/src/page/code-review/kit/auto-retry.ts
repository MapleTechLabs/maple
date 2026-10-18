import { Duration, Effect, Option, Queue, Stream } from "effect"

// `useNetworkAutoRetry` (apps/web/src/hooks/use-network-auto-retry.ts): while a retryable error is
// on screen, probe on a jittered backoff and when the browser comes back online. Each page wraps
// this in its own Mount (`ErrorState`'s `autoRetry`), dispatching its retry Message.
// TODO(auto-retry): after the last attempt legacy drops "Retrying automatically…"; here it stays.

const POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000]
const MAX_POLL_ATTEMPTS = 6

const isReachable = () => !document.hidden && navigator.onLine !== false

const polls = <A>(retry: () => A): Stream.Stream<A> =>
	Stream.fromIterable(Array.from({ length: MAX_POLL_ATTEMPTS }, (_, attempt) => attempt)).pipe(
		Stream.mapEffect((attempt) => {
			const base = POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 30_000
			return Effect.sleep(Duration.millis(base * (0.9 + Math.random() * 0.2))).pipe(
				Effect.map(() => (isReachable() ? Option.some(retry()) : Option.none())),
			)
		}),
		Stream.flatMap((maybe) => Option.match(maybe, { onNone: () => Stream.empty, onSome: Stream.make })),
	)

const online = <A>(retry: () => A): Stream.Stream<A> =>
	Stream.callback<A>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const onOnline = () => void Queue.offerUnsafe(queue, retry())
				window.addEventListener("online", onOnline)
				return onOnline
			}),
			(onOnline) => Effect.sync(() => window.removeEventListener("online", onOnline)),
		).pipe(Effect.flatMap(() => Effect.never)),
	)

export const autoRetryStream = <A>(retry: () => A): Stream.Stream<A> =>
	Stream.merge(polls(retry), online(retry))
