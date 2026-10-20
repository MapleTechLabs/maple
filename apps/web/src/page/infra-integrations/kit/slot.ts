import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { Resources } from "../../../platform/resources"

/**
 * One `Keyed.request` for a page that re-derives its reads after every answer: the next slot and
 * its fetch. A `Load` for the key already in the slot asks nothing, even after a failure (an atom
 * that failed stays failed until something refreshes it); a new key or a `Refresh` asks again.
 */
export const requestSlot = <A, E, M>(
	current: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: () => Command.Command<M, never, Resources>,
): readonly [Keyed.Keyed<A, E>, ReadonlyArray<Command.Command<M, never, Resources>>] =>
	mode === "Load" && current.key === key
		? [current, []]
		: Option.match(Keyed.request(current, key, mode), {
				onNone: () => [current, []] as const,
				onSome: (next) => [next, [fetch()]] as const,
			})
