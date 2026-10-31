import { Option, Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { orgOfKey, type RequestKey } from "./request-key"

/**
 * One request slot in a page Model: the `AsyncData` plus the key it was last requested under.
 * This is what one `useAtomValue(queryAtom(input))` call site becomes. `retained`: the data on
 * screen answers an earlier key (`useRetainedResult`), so a failure of the new key shows as one.
 * `retrying`: a failed slot asked again; the failure stays on screen until the answer lands.
 */
export type Keyed<A, E> = Readonly<{
	key: RequestKey | null
	data: AsyncData.AsyncData<A, E>
	retained?: boolean
	retrying?: boolean
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
	})

export const idle = <A, E>(): Keyed<A, E> => ({ key: null, data: AsyncData.Idle() })

/** A superseding re-read's key: the request key plus a generation, so an older answer is dropped. */
const GENERATION_SEPARATOR = "\u0001"

/** The request key a slot key was built from (a superseding re-read adds a generation). */
export const baseKey = (key: RequestKey): RequestKey => key.split(GENERATION_SEPARATOR)[0] ?? key

const generationOf = (key: RequestKey | null): number =>
	key === null ? 0 : Number(key.split(GENERATION_SEPARATOR)[1] ?? "0")

/** A slot just requested: its key is the one to fetch with. */
export type Requested<A, E> = Keyed<A, E> & Readonly<{ key: RequestKey }>

const withRetained = <A, E>(
	key: RequestKey,
	data: AsyncData.AsyncData<A, E>,
	retained: boolean,
): Requested<A, E> => (retained ? { key, data, retained } : { key, data })

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
				: Option.some({ key: slot.key, data: slot.data, retrying: true })
		}
		const transition =
			mode === "Load" ? AsyncData.loadIfMissing(slot.data) : AsyncData.revalidateOrLoad(slot.data)
		// The slot's own key, generation included, so a read it superseded stays dropped.
		const current = slot.key
		return Option.map(transition, (data) => withRetained(current, data, slot.retained === true))
	}
	const sameOrg = slot.key !== null && orgOfKey(slot.key) === orgOfKey(key)
	return Option.some(
		Option.match(sameOrg ? AsyncData.getData(slot.data) : Option.none(), {
			onNone: (): Requested<A, E> => ({ key, data: AsyncData.Loading() }),
			onSome: (previous) => withRetained(key, AsyncData.Refreshing({ data: previous }), true),
		}),
	)
}

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
 */
export const accept = <A, E>(slot: Keyed<A, E>, key: RequestKey, result: Result.Result<A, E>): Keyed<A, E> =>
	slot.key !== key
		? slot
		: {
				key,
				data:
					slot.retained === true && Result.isFailure(result)
						? AsyncData.Failure({ error: result.failure })
						: AsyncData.settle(slot.data, result),
			}
