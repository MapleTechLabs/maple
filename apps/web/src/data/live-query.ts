import {
	type Context,
	createLiveQueryCollection,
	type GetResult,
	type InitialQueryBuilder,
	type QueryBuilder,
} from "@tanstack/db"
import { Effect, Queue, Stream } from "effect"

interface LiveQuery {
	readonly subscription: { readonly unsubscribe: () => void }
	readonly collection: { readonly cleanup: () => Promise<void> }
}

/**
 * A failed cleanup must not take the app down; the live query is gone either way. Each step is
 * ignored on its own, so a throwing `unsubscribe` still cleans the collection up.
 */
export const releaseLiveQuery = ({ collection, subscription }: LiveQuery): Effect.Effect<void> =>
	Effect.andThen(
		Effect.ignore(Effect.try(() => subscription.unsubscribe())),
		Effect.ignore(Effect.tryPromise(() => collection.cleanup())),
	)

/**
 * `useLiveQuery` as a Subscription stream (Hazel `apps/web/src/data/live-query.ts`):
 * emits the full result once the live query is ready and again after every change, and cleans
 * the live query up when the Subscription's dependencies change or it is torn down.
 */
export const liveQueryStream = <TContext extends Context, Message>(
	query: (q: InitialQueryBuilder) => QueryBuilder<TContext>,
	toMessage: (rows: ReadonlyArray<GetResult<TContext>>) => Message,
): Stream.Stream<Message> =>
	Stream.callback<Message>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const collection = createLiveQueryCollection({ query, startSync: true })
				const emit = () => Queue.offerUnsafe(queue, toMessage(collection.toArray))
				const subscription = collection.subscribeChanges(emit)
				collection.onFirstReady(emit)
				return { collection, subscription }
			}),
			releaseLiveQuery,
		).pipe(Effect.andThen(Effect.never)),
	)
