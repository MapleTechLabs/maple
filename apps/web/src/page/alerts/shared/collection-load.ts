import { Effect, Option, Queue, Schema, Stream } from "effect"

// Whether a collection a page is still waiting on failed to load. TODO(collection-load): heal a
// stuck collection.

/** `COLLECTION_LOAD_TIMEOUT_MS`: how long a collection may sit loading with nothing to show. */
export const COLLECTION_LOAD_TIMEOUT_MS = 30_000

/** How long a page waits on a collection it only enriches with before reading it as empty. */
export const ENRICHMENT_LOAD_TIMEOUT_MS = 3_000

const decodeDetail = Schema.decodeUnknownOption(Schema.Struct({ collectionId: Schema.String }))

/** Emits once when the stream gave up (`collection:sync-failed`) or the timeout passed. */
export const collectionLoadFailed = <M>(
	collectionId: string,
	message: () => M,
	timeoutMs: number = COLLECTION_LOAD_TIMEOUT_MS,
): Stream.Stream<M> =>
	Stream.callback<M>((queue) =>
		Effect.acquireRelease(
			Effect.sync(() => {
				const fail = () => Queue.offerUnsafe(queue, message())
				const onSyncFailed = (event: Event) => {
					const detail = event instanceof CustomEvent ? decodeDetail(event.detail) : Option.none()
					if (Option.exists(detail, (value) => value.collectionId === collectionId)) fail()
				}
				window.addEventListener("collection:sync-failed", onSyncFailed)
				const timeout = window.setTimeout(fail, timeoutMs)
				return { onSyncFailed, timeout }
			}),
			({ onSyncFailed, timeout }) =>
				Effect.sync(() => {
					window.removeEventListener("collection:sync-failed", onSyncFailed)
					window.clearTimeout(timeout)
				}),
		).pipe(Effect.andThen(Effect.never)),
	)
