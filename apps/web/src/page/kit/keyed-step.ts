import { Option, Array as Arr } from "effect"
import { AsyncData, type Command } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import type { Resources } from "../../platform/resources"
import type { PageReturn } from "../contract"

// One request slot's step and the way steps compose: the Model threaded through, the Commands
// concatenated, the last OutMessage kept.

type Fetch<Message> = (key: string) => Command.Command<Message, never, Resources>

/** One slot's request (`Keyed.request`, S6): the Model patch that writes it and its fetch. */
export type Step<Model, Message> = Readonly<{
	patch: Partial<Model>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

/**
 * Reads `slot` under `key` in `mode`: the patch and the fetch, or an empty step. `keepFailure`: a
 * `Load` of the key that just failed leaves the failure up, so only Reload or Try again asks again.
 */
export const keyed = <Model, Message, A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.ReadMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: Fetch<Message>,
	options?: Readonly<{ keepFailure?: boolean }>,
): Step<Model, Message> =>
	options?.keepFailure === true && mode === "Load" && slot.key === key && AsyncData.isFailure(slot.data)
		? { patch: {}, commands: [] }
		: Option.match(Keyed.requestFor(slot, key, mode), {
				onNone: () => ({ patch: {}, commands: [] }),
				onSome: (next) => ({ patch: write(next), commands: [fetch(next.key)] }),
			})

/** `keyed` for a slot the caller places itself: the next slot (unchanged when nothing to do) and its fetch. */
export const keyedSlot = <Message, A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: Fetch<Message>,
): Readonly<{
	slot: Keyed.Keyed<A, E>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}> =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ slot, commands: [] }),
		onSome: (next) => ({ slot: next, commands: [fetch(next.key)] }),
	})

/** Steps built against one Model: their patches applied in order, their fetches concatenated. */
export const applySteps = <Model, Message>(
	model: Model,
	steps: ReadonlyArray<Step<NoInfer<Model>, Message>>,
): {
	readonly model: Model
	readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
} => ({
	model: Arr.reduce(steps, model, (next, step) => ({ ...next, ...step.patch })),
	commands: Arr.flatMap(steps, (step) => step.commands),
})

/** Steps run in order, each against the Model the previous ones patched, after `prior`. */
export const runSteps = <Model, Message>(
	model: NoInfer<Model>,
	steps: ReadonlyArray<(model: Model) => Step<Model, Message>>,
	prior?: PageReturn<NoInfer<Model>, NoInfer<Message>>,
): PageReturn<Model, Message> =>
	Arr.reduce<(model: Model) => Step<Model, Message>, PageReturn<Model, Message>>(
		steps,
		prior ?? { model },
		(result, step) => {
			const next = step(result.model)
			return {
				...result,
				model: { ...result.model, ...next.patch },
				commands: [...(result.commands ?? []), ...next.commands],
			}
		},
	)

/** A record of slots (one per chart metric) requested together: the next record and its fetches. */
export const seriesSteps = <A, E, Message>(
	slots: Readonly<Record<string, Keyed.Keyed<A, E>>>,
	requests: ReadonlyArray<Readonly<{ id: string; key: string; fetch: Fetch<Message> }>>,
	mode: Keyed.RequestMode,
) =>
	Arr.reduce<
		(typeof requests)[number],
		{
			readonly slots: Readonly<Record<string, Keyed.Keyed<A, E>>>
			readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
		}
	>(requests, { slots, commands: [] }, (acc, request) =>
		Option.match(Keyed.request(acc.slots[request.id] ?? Keyed.idle<A, E>(), request.key, mode), {
			onNone: () => acc,
			onSome: (next) => ({
				slots: { ...acc.slots, [request.id]: next },
				commands: [...acc.commands, request.fetch(request.key)],
			}),
		}),
	)

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
): PageReturn<M, Msg> =>
	Arr.reduce<(model: M) => PageReturn<M, Msg>, PageReturn<M, Msg>>(steps, { model }, (acc, step) =>
		chain(acc, step),
	)
