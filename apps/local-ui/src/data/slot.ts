import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { LoadFailure } from "./local-query"

/**
 * One query as Model data: the `AsyncData` and the key it was last requested
 * under. A new key keeps the previous rows on screen until its own rows arrive.
 */
export type Slot<A> = Readonly<{
	key: string | null
	data: AsyncData.AsyncData<A, LoadFailure>
	/** The rows on screen are another key's. */
	isPlaceholder: boolean
	/** `dataUpdatedAt` of the rows on screen; null where the page does not track it. */
	updatedAtMs: number | null
	/** The rows on screen are an older window's, opened from the cache (`standInSince`). */
	isStandIn: boolean
}>

export const SlotSchema = <A, AI>(dataSchema: Schema.Codec<A, AI>) =>
	Schema.Struct({
		key: Schema.NullOr(Schema.String),
		data: AsyncData.Schema(dataSchema, LoadFailure).schema,
		isPlaceholder: Schema.Boolean,
		updatedAtMs: Schema.NullOr(Schema.Number),
		isStandIn: Schema.Boolean,
	})

export const idle = <A>(): Slot<A> => ({
	key: null,
	data: AsyncData.Idle(),
	isPlaceholder: false,
	updatedAtMs: null,
	isStandIn: false,
})

/** A key for one query: its name and inputs, as the cache hashes it. */
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
	const isNewKey = slot.key !== key
	return Option.some({
		key,
		data,
		isPlaceholder: isNewKey && Option.isSome(maybePrevious),
		updatedAtMs: slot.updatedAtMs,
		isStandIn: !isNewKey && slot.isStandIn,
	})
}

/**
 * Folds a result in only if it answers the slot's current key; a superseded answer is dropped.
 * A failed new key drops the placeholder rows (they were another key's); a failed refetch keeps them.
 */
export const accept = <A>(
	slot: Slot<A>,
	key: string,
	result: Result.Result<A, LoadFailure>,
	atMs: number | null = null,
): Slot<A> => {
	if (slot.key !== key) return slot
	const data =
		slot.isPlaceholder && Result.isFailure(result)
			? AsyncData.fail<LoadFailure, A>(result.failure)
			: AsyncData.settle(slot.data, result)
	return Result.isSuccess(result)
		? { key, data, isPlaceholder: false, updatedAtMs: atMs ?? slot.updatedAtMs, isStandIn: false }
		: { ...slot, key, data, isPlaceholder: false }
}

/**
 * The cache answered for the current key before the fetch did: show it (an exact result, or an
 * older window standing in), unless a fetch already filled the slot. `isFresh`: no fetch follows.
 */
export const acceptCached = <A>(
	slot: Slot<A>,
	key: string,
	cached: Readonly<{ data: A; updatedAtMs: number; isStandIn: boolean }>,
	isFresh: boolean,
): Slot<A> => {
	if (slot.key !== key || (Option.isSome(AsyncData.getData(slot.data)) && !slot.isPlaceholder)) return slot
	return {
		key,
		data: isFresh
			? AsyncData.Success({ data: cached.data })
			: AsyncData.Refreshing({ data: cached.data }),
		isPlaceholder: false,
		updatedAtMs: cached.updatedAtMs,
		isStandIn: cached.isStandIn,
	}
}

/** What `shown.ts` reads off one query on screen. */
export type Shown = Readonly<{ atMs: number; isStandIn: boolean; isRefreshing: boolean; isFailed: boolean }>

/** The slot's rows as the stale-data notice sees them: none for placeholders or untracked slots. */
export const shownOf = <A>(slot: Slot<A>): Option.Option<Shown> => {
	if (slot.isPlaceholder || slot.updatedAtMs === null || Option.isNone(AsyncData.getData(slot.data)))
		return Option.none()
	return Option.some({
		atMs: slot.updatedAtMs,
		isStandIn: slot.isStandIn,
		isRefreshing: AsyncData.isRefreshing(slot.data),
		isFailed: AsyncData.isStale(slot.data),
	})
}

/** Pending: no data yet, nothing to show. */
export const isPending = <A>(slot: Slot<A>): boolean =>
	Option.isNone(AsyncData.getData(slot.data)) && !AsyncData.isFailure(slot.data)

/** `failedWithoutData`: a failure with nothing to show (a failed refresh keeps its rows). */
export const failureWithoutData = <A>(slot: Slot<A>): Option.Option<LoadFailure> =>
	AsyncData.isFailure(slot.data) ? AsyncData.getError(slot.data) : Option.none()

/** A fetch for the slot's key is in flight (a first load, a refetch or a new key). */
export const isInFlight = <A>(slot: Slot<A>): boolean =>
	AsyncData.isLoading(slot.data) || AsyncData.isRefreshing(slot.data)

/** `fetchNextPage` may extend the rows: they are this key's own and no fetch will replace them. */
export const canExtend = <A>(slot: Slot<A>): boolean => !slot.isPlaceholder && !isInFlight(slot)
