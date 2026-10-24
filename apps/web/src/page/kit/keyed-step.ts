import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../data/keyed"
import type { LoadFailure } from "../../data/load-failure"
import type { Resources } from "../../platform/resources"
import type { PageReturn } from "../contract"

// One request slot's step and the way steps compose: the Model threaded through, the Commands
// concatenated, the last OutMessage kept.

/** Reads `slot` under `key` in `mode`: the requested slot and its fetch, or nothing to do. */
export const slotStep = <M, Msg, A>(
	model: M,
	slot: Keyed.Keyed<A, LoadFailure>,
	write: (next: Keyed.Keyed<A, LoadFailure>) => Partial<M>,
	key: string,
	mode: Keyed.ReadMode,
	command: (key: string) => Command.Command<NoInfer<Msg>, never, Resources>,
): PageReturn<M, Msg> =>
	Option.match(Keyed.requestFor(slot, key, mode), {
		onNone: () => ({ model }),
		onSome: (next) => ({ model: { ...model, ...write(next) }, commands: [command(next.key)] }),
	})

export const chain = <M, Msg>(
	first: PageReturn<M, Msg>,
	next: (model: M) => PageReturn<M, Msg>,
): PageReturn<M, Msg> => {
	const second = next(first.model)
	return {
		...second,
		commands: [...(first.commands ?? []), ...(second.commands ?? [])],
		outMessage: second.outMessage ?? first.outMessage,
	}
}

export const chainAll = <M, Msg>(
	model: M,
	steps: ReadonlyArray<(model: M) => PageReturn<M, Msg>>,
): PageReturn<M, Msg> => steps.reduce<PageReturn<M, Msg>>((acc, step) => chain(acc, step), { model })
