import { Option, Result, Schema, String as Str } from "effect"
import { AsyncData } from "foldkit"
import { orgOfKey, type RequestKey } from "./request-key"

/**
 * One request slot in a page Model: the `AsyncData` plus the key it was last requested under.
 * This is what one `useAtomValue(queryAtom(input))` call site becomes. `retained`: the data on
 * screen answers an earlier key (`useRetainedResult`), so a failure of the new key shows as one.
 * `retrying`: a failed slot asked again; the failure stays on screen until the answer lands.
 * `updatedAtMs`: when the data on screen was fetched, for pages that show its age. `isStandIn`: the
 * data on screen is a cached answer for another window, shown until this key's answer lands.
 */
export type Keyed<A, E> = Readonly<{
	key: RequestKey | null
	data: AsyncData.AsyncData<A, E>
	retained?: boolean
	retrying?: boolean
	updatedAtMs?: number
	isStandIn?: boolean
}>

export const KeyedSchema = <A, AI, E, EI>(
	dataSchema: Schema.Codec<A, AI>,
	errorSchema: Schema.Codec<E, EI>,
) =>
	Schema.Struct({
		key: Schema.NullOr(Schema.String),
		data: AsyncData.Schema(dataSchema, errorSchema).schema,
		retained: Schema.optionalKey(Schema.Boolean),
		retrying: Schema.optionalKey(Schema.Boolean),
		updatedAtMs: Schema.optionalKey(Schema.Number),
		isStandIn: Schema.optionalKey(Schema.Boolean),
	})

export const idle = <A, E>(): Keyed<A, E> => ({ key: null, data: AsyncData.Idle() })

/** The slot stored under `key`, or an idle one when the record has none yet. */
export const at = <A, E>(slots: Readonly<Record<string, Keyed<A, E>>>, key: string): Keyed<A, E> =>
	slots[key] ?? idle()

/** A superseding re-read's key: the request key plus a generation, so an older answer is dropped. */
const GENERATION_SEPARATOR = "\u0001"

/** The request key a slot key was built from (a superseding re-read adds a generation). */
export const baseKey = (key: RequestKey): RequestKey => Str.split(GENERATION_SEPARATOR)(key)[0] ?? key

const generationOf = (key: RequestKey | null): number =>
	key === null ? 0 : Number(Str.split(GENERATION_SEPARATOR)(key)[1] ?? "0")

/** A slot just requested: its key is the one to fetch with. */
export type Requested<A, E> = Keyed<A, E> & Readonly<{ key: RequestKey }>

/** The fetch time a slot carries to its next state; a stand-in stays one only under its own key. */
const shownMeta = <A, E>(
	slot: Keyed<A, E>,
	isSameKey: boolean,
): Pick<Keyed<A, E>, "updatedAtMs" | "isStandIn"> => {
	const { updatedAtMs } = slot
	const isStandIn = isSameKey && slot.isStandIn === true
	if (updatedAtMs === undefined) return isStandIn ? { isStandIn: true } : {}
	return isStandIn ? { updatedAtMs, isStandIn: true } : { updatedAtMs }
}

const withRetained = <A, E>(
	key: RequestKey,
	data: AsyncData.AsyncData<A, E>,
	retained: boolean,
	meta: Pick<Keyed<A, E>, "updatedAtMs" | "isStandIn">,
): Requested<A, E> => (retained ? { key, data, retained, ...meta } : { key, data, ...meta })

/**
 * `Load` is route entry or an input change; `Refresh` is the explicit refresh (`useAtomRefresh`).
 * Same key: `Load` keeps cached data and never restarts an in-flight request, `Refresh`
 * revalidates. New key: always requests, keeping the previous data on screen (`Refreshing`) unless
 * the org changed.
 */
export type RequestMode = "Load" | "Refresh"

/** `Some(next)`: put `next` in the Model and return the fetch Command. `None`: nothing to do. */
export const request = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	mode: RequestMode,
): Option.Option<Requested<A, E>> => {
	if (slot.key !== null && baseKey(slot.key) === baseKey(key)) {
		// A retry of a failure (often an auto-retry probe) keeps the error up, not a skeleton.
		if (AsyncData.isFailure(slot.data)) {
			return slot.retrying === true
				? Option.none()
				: Option.some({ key: slot.key, data: slot.data, retrying: true, ...shownMeta(slot, true) })
		}
		const transition =
			mode === "Load" ? AsyncData.loadIfMissing(slot.data) : AsyncData.revalidateOrLoad(slot.data)
		// The slot's own key, generation included, so a read it superseded stays dropped.
		const current = slot.key
		return Option.map(transition, (data) =>
			withRetained(current, data, slot.retained === true, shownMeta(slot, true)),
		)
	}
	const sameOrg = slot.key !== null && orgOfKey(slot.key) === orgOfKey(key)
	return Option.some(
		Option.match(sameOrg ? AsyncData.getData(slot.data) : Option.none(), {
			onNone: (): Requested<A, E> => ({ key, data: AsyncData.Loading(), ...shownMeta(slot, false) }),
			onSome: (previous) =>
				withRetained(key, AsyncData.Refreshing({ data: previous }), true, shownMeta(slot, false)),
		}),
	)
}

/**
 * `request` for pages without an auto-retry probe (the dashboard has one): a `Load` under the slot's own key leaves a failure
 * on screen, so only a `Refresh` (Try again) asks again.
 */
export const requestKeepingFailure = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	mode: RequestMode,
): Option.Option<Requested<A, E>> =>
	mode === "Load" &&
	slot.key !== null &&
	baseKey(slot.key) === baseKey(key) &&
	AsyncData.isFailure(slot.data)
		? Option.none()
		: request(slot, key, mode)

/** A parked page coming back: a failed slot is forgotten, so entry asks again as a fresh mount would. */
export const forgetFailure = <A, E>(slot: Keyed<A, E>): Keyed<A, E> =>
	AsyncData.isFailure(slot.data) ? idle() : slot

/**
 * A re-read after a write (reactivity invalidation): always requests, even with a read in flight,
 * under a new generation of `key`, so the older answer is dropped. Fetch with the returned `key`.
 */
export const supersede = <A, E>(slot: Keyed<A, E>, key: RequestKey): Requested<A, E> => {
	const base = baseKey(key)
	const isSame = slot.key !== null && baseKey(slot.key) === base
	const generation = isSame ? generationOf(slot.key) + 1 : 1
	// A read in flight keeps its state; the new generation's answer is the one that lands.
	const requested = Option.getOrElse(request(slot, base, "Refresh"), () => slot)
	return { ...requested, key: `${base}${GENERATION_SEPARATOR}${generation}` }
}

/** `Supersede`: the re-read after a write, which a read already in flight cannot swallow. */
export type ReadMode = RequestMode | "Supersede"

/** `request` or `supersede` by mode. `Some(next)`: fetch with `next.key`. */
export const requestFor = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	mode: ReadMode,
): Option.Option<Requested<A, E>> =>
	mode === "Supersede" ? Option.some(supersede(slot, key)) : request(slot, key, mode)

/**
 * Folds a result in only if it answers the slot's current key; a superseded answer is dropped.
 * A failure over retained data from an earlier key is a plain `Failure`, not stale data.
 * `atMs`: the fetch time of a success, kept as `updatedAtMs`; a failure keeps the shown data's.
 */
export const accept = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	result: Result.Result<A, E>,
	atMs?: number,
): Keyed<A, E> => {
	if (slot.key !== key) return slot
	const data =
		slot.retained === true && Result.isFailure(result)
			? AsyncData.Failure({ error: result.failure })
			: AsyncData.settle(slot.data, result)
	if (Result.isFailure(result)) return { key, data, ...shownMeta(slot, true) }
	const updatedAtMs = atMs ?? slot.updatedAtMs
	return updatedAtMs === undefined ? { key, data } : { key, data, updatedAtMs }
}

/** A cached answer: its data, when it was fetched, and whether it is another window's. */
export type CachedAnswer<A> = Readonly<{ data: A; updatedAtMs: number; isStandIn: boolean }>

/**
 * The cache answered for the current key before the fetch did: show it (an exact answer, or
 * another window's standing in), unless a fetch already filled the slot. `isFresh`: no fetch follows.
 */
export const acceptCached = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	cached: CachedAnswer<A>,
	isFresh: boolean,
): Keyed<A, E> => {
	if (slot.key !== key || (Option.isSome(AsyncData.getData(slot.data)) && slot.retained !== true))
		return slot
	const data = isFresh
		? AsyncData.Success({ data: cached.data })
		: AsyncData.Refreshing({ data: cached.data })
	return cached.isStandIn
		? { key, data, updatedAtMs: cached.updatedAtMs, isStandIn: true }
		: { key, data, updatedAtMs: cached.updatedAtMs }
}

/** No data yet and no failure: nothing to show but a skeleton. */
export const isAwaitingFirstData = <A, E>(slot: Keyed<A, E>): boolean =>
	Option.isNone(AsyncData.getData(slot.data)) && !AsyncData.isFailure(slot.data)

/** A failure with nothing to show (a failed refresh keeps its data beside the error). */
export const failureWithoutData = <A, E>(slot: Keyed<A, E>): Option.Option<E> =>
	AsyncData.isFailure(slot.data) ? AsyncData.getError(slot.data) : Option.none()

/** A fetch for the slot's key is in flight (a first load, a refetch, a new key or a retry of a failure). */
export const isInFlight = <A, E>(slot: Keyed<A, E>): boolean =>
	AsyncData.isLoading(slot.data) ||
	AsyncData.isRefreshing(slot.data) ||
	(AsyncData.isFailure(slot.data) && slot.retrying === true)

/** A next page may extend the data: it is this key's own and no fetch will replace it. */
export const canExtend = <A, E>(slot: Keyed<A, E>): boolean => slot.retained !== true && !isInFlight(slot)
