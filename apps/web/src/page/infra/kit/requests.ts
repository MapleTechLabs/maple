import { Option } from "effect"
import type { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import type { Resources } from "../../../platform/resources"

// The S8 request step (`Keyed.request` writes the slot and yields its fetch), shared by every
// infra page so each `update` lists its slots and nothing else.

export type Step<Model, Message> = Readonly<{
	patch: Partial<Model>
	commands: ReadonlyArray<Command.Command<Message, never, Resources>>
}>

export const keyed = <Model, Message, A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	write: (next: Keyed.Keyed<A, E>) => Partial<Model>,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): Step<Model, Message> =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => ({ patch: {}, commands: [] }),
		onSome: (next) => ({ patch: write(next), commands: [fetch(key)] }),
	})

/** A record of slots (one per chart metric) requested together: the next record and its fetches. */
export const seriesSteps = <A, E, Message>(
	slots: Readonly<Record<string, Keyed.Keyed<A, E>>>,
	requests: ReadonlyArray<
		Readonly<{
			id: string
			key: string
			fetch: (key: string) => Command.Command<Message, never, Resources>
		}>
	>,
	mode: Keyed.RequestMode,
) =>
	requests.reduce<{
		readonly slots: Readonly<Record<string, Keyed.Keyed<A, E>>>
		readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
	}>(
		(acc, request) =>
			Option.match(Keyed.request(acc.slots[request.id] ?? Keyed.idle<A, E>(), request.key, mode), {
				onNone: () => acc,
				onSome: (next) => ({
					slots: { ...acc.slots, [request.id]: next },
					commands: [...acc.commands, request.fetch(request.key)],
				}),
			}),
		{ slots, commands: [] },
	)

export const applySteps = <Model, Message>(
	model: Model,
	steps: ReadonlyArray<Step<Model, Message>>,
): {
	readonly model: Model
	readonly commands: ReadonlyArray<Command.Command<Message, never, Resources>>
} => ({
	model: steps.reduce<Model>((next, step) => ({ ...next, ...step.patch }), model),
	commands: steps.flatMap((step) => step.commands),
})
