import { Option, type Result, Schema } from "effect"
import { AsyncData } from "foldkit"
import { orgOfKey, type RequestKey } from "./request-key"

/**
 * One request slot in a page Model: the `AsyncData` plus the key it was last requested under.
 * This is what one `useAtomValue(queryAtom(input))` call site becomes.
 */
export type Keyed<A, E> = Readonly<{ key: RequestKey | null; data: AsyncData.AsyncData<A, E> }>

export const KeyedSchema = <A, AI, E, EI>(
	dataSchema: Schema.Codec<A, AI>,
	errorSchema: Schema.Codec<E, EI>,
) =>
	Schema.Struct({
		key: Schema.NullOr(Schema.String),
		data: AsyncData.Schema(dataSchema, errorSchema).schema,
	})

export const idle = <A, E>(): Keyed<A, E> => ({ key: null, data: AsyncData.Idle() })

/**
 * `Load` is route entry or an input change; `Refresh` is the explicit refresh (`useAtomRefresh`).
 * Same key: `Load` keeps cached data and never restarts an in-flight request, `Refresh`
 * revalidates. New key: always requests, keeping the previous data on screen (`Refreshing`) unless
 * the org changed, which is apps/web's `useRetainedResult` (`lib/effect-atom.ts`).
 */
export type RequestMode = "Load" | "Refresh"

/** `Some(next)`: put `next` in the Model and return the fetch Command. `None`: nothing to do. */
export const request = <A, E>(
	slot: Keyed<A, E>,
	key: RequestKey,
	mode: RequestMode,
): Option.Option<Keyed<A, E>> => {
	if (slot.key === key) {
		const transition =
			mode === "Load" ? AsyncData.loadIfMissing(slot.data) : AsyncData.revalidateOrLoad(slot.data)
		return Option.map(transition, (data) => ({ key, data }))
	}
	const sameOrg = slot.key !== null && orgOfKey(slot.key) === orgOfKey(key)
	const data = Option.match(sameOrg ? AsyncData.getData(slot.data) : Option.none(), {
		onNone: (): AsyncData.AsyncData<A, E> => AsyncData.Loading(),
		onSome: (previous) => AsyncData.Refreshing({ data: previous }),
	})
	return Option.some({ key, data })
}

/** Folds a result in only if it answers the slot's current key; a superseded answer is dropped. */
export const accept = <A, E>(slot: Keyed<A, E>, key: RequestKey, result: Result.Result<A, E>): Keyed<A, E> =>
	slot.key === key ? { key, data: AsyncData.settle(slot.data, result) } : slot
