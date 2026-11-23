import {
	type Context,
	createLiveQueryCollection,
	type GetResult,
	type InitialQueryBuilder,
	type QueryBuilder,
} from "@tanstack/db"
import { Array as Arr, Effect, Queue, Schema, Stream } from "effect"

interface LiveQuery {
	readonly subscription: { readonly unsubscribe: () => void }
	readonly collection: { readonly cleanup: () => Promise<void> }
}

export class LiveQueryReleaseError extends Schema.TaggedError<LiveQueryReleaseError>()(
	"@maple/web/LiveQueryReleaseError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

/**
 * A failed cleanup must not take the app down; the live query is gone either way. Each step is
 * ignored on its own, so a throwing `unsubscribe` still cleans the collection up.
 */
export const releaseLiveQuery = ({ collection, subscription }: LiveQuery): Effect.Effect<void> =>
	Effect.andThen(
		Effect.ignore(
			Effect.try({
				try: () => subscription.unsubscribe(),
				catch: (cause) =>
					new LiveQueryReleaseError({ message: "Could not unsubscribe the live query", cause }),
			}),
		),
		Effect.ignore(
			Effect.tryPromise({
				try: () => collection.cleanup(),
				catch: (cause) =>
					new LiveQueryReleaseError({ message: "Could not clean up the live query", cause }),
			}),
		),
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
				let sent: ReadonlyArray<GetResult<TContext>> = []
				const emit = () => {
					sent = collection.toArray
					Queue.offerUnsafe(queue, toMessage(sent))
				}
				// Rows sent last, compared by reference: an order-only move changes them, the empty
				// event markReady sends right after the ready callbacks does not.
				const moved = () => {
					const rows = collection.toArray
					return rows.length !== sent.length || Arr.some(rows, (row, index) => row !== sent[index])
				}
				// Without the initial state TanStack DB drops later deletes of rows this subscriber never
				// received, so a deleted row stayed listed. The first ready emits once; changes emit after
				// it, and an empty batch (TanStack's layout notification) only when the rows moved.
				let isReady = false
				const subscription = collection.subscribeChanges(
					(changes) => {
						if (isReady && (changes.length > 0 || moved())) emit()
					},
					{ includeInitialState: true },
				)
				collection.onFirstReady(() => {
					isReady = true
					emit()
				})
				return { collection, subscription }
			}),
			releaseLiveQuery,
		).pipe(Effect.andThen(Effect.never)),
	)
