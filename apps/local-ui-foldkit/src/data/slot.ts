import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "./local-query"

/**
 * One React Query `useQuery` as Model data: the `AsyncData` and the key it was last requested
 * under. A new key keeps the previous rows on screen (`placeholderData: keepPreviousData`).
 */
export type Slot<A> = Readonly<{
	key: string | null
	data: AsyncData.AsyncData<A, LoadFailure>
	/** React Query's `isPlaceholderData`: the rows on screen are another key's. */
	isPlaceholder: boolean
}>

export const SlotSchema = <A, AI>(dataSchema: Schema.Codec<A, AI>) =>
	Schema.Struct({
		key: Schema.NullOr(Schema.String),
		data: AsyncData.Schema(dataSchema, LoadFailure).schema,
		isPlaceholder: Schema.Boolean,
	})

export const idle = <A>(): Slot<A> => ({ key: null, data: AsyncData.Idle(), isPlaceholder: false })

/** A key for one query: its name and inputs, as React Query hashes `queryKey`. */
export const keyOf = (name: string, input: unknown): string => `${name}:${JSON.stringify(input)}`

/**
 * `Some(next)` when the key changed (or `force` refetches): put it in the Model and fetch.
 * `None` when the slot already holds or is fetching this key.
 */
export const request = <A>(slot: Slot<A>, key: string, force = false): Option.Option<Slot<A>> => {
	if (slot.key === key && !force) return Option.none()
	const maybePrevious = AsyncData.getData(slot.data)
	const data = Option.match(maybePrevious, {
		onNone: (): AsyncData.AsyncData<A, LoadFailure> => AsyncData.Loading(),
		onSome: (previous) => AsyncData.Refreshing({ data: previous }),
	})
	return Option.some({ key, data, isPlaceholder: slot.key !== key && Option.isSome(maybePrevious) })
}

/**
 * Folds a result in only if it answers the slot's current key; a superseded answer is dropped.
 * A failed new key drops the placeholder rows (they were another key's); a failed refetch keeps them.
 */
export const accept = <A>(slot: Slot<A>, key: string, result: Result.Result<A, LoadFailure>): Slot<A> => {
	if (slot.key !== key) return slot
	const data =
		slot.isPlaceholder && Result.isFailure(result)
			? AsyncData.fail<LoadFailure, A>(result.failure)
			: AsyncData.settle(slot.data, result)
	return { key, data, isPlaceholder: false }
}

/** React Query's `isPending`: no data yet, nothing to show. */
export const isPending = <A>(slot: Slot<A>): boolean =>
	Option.isNone(AsyncData.getData(slot.data)) && !AsyncData.isFailure(slot.data)

/** `failedWithoutData`: a failure with nothing to show (a failed refresh keeps its rows). */
export const failureWithoutData = <A>(slot: Slot<A>): Option.Option<LoadFailure> =>
	AsyncData.isFailure(slot.data) ? AsyncData.getError(slot.data) : Option.none()
