import {
	type Context,
	createLiveQueryCollection,
	type GetResult,
	type InitialQueryBuilder,
	type QueryBuilder,
} from "@tanstack/db"
import { Effect, Queue, Stream } from "effect"

/**
 * `useLiveQuery` as a Subscription stream (Hazel `apps/web-foldkit/src/data/live-query.ts`):
 * emits the full result once the live query is ready and again after every change, and cleans
 * the live query up when the Subscription's dependencies change or it is torn down. The query
 * builder is the same one apps/web passes to `useLiveQuery`, so filters and order match exactly.
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
			({ collection, subscription }) =>
				// A failed cleanup must not take the app down; the live query is gone either way.
				Effect.tryPromise(() => {
					subscription.unsubscribe()
					return collection.cleanup()
				}).pipe(Effect.ignore),
		).pipe(Effect.andThen(Effect.never)),
	)
