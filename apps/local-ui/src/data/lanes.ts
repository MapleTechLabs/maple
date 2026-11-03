import { Array, Function } from "effect"
import { Command } from "foldkit"
import { isInFlight, type Keyed } from "@maple/views/data/keyed"

// A query nothing reads any more is aborted, and chDB runs one query at a
// time, so a superseded or abandoned request must not hold up the ones behind it.

type Outcome = Command.Interruptible.Outcome

/** An Interrupt's result as is; the root lifts it into its own Message. */
export const outcomeOf: (outcome: Outcome) => Outcome = Function.identity

/** One request a page may have in flight: the Command it runs as, the key it answers, how to stop it. */
export type Lane = Readonly<{
	scope: string
	key: string
	isInFlight: boolean
	stop: () => Command.Command<Outcome>
}>

/** A slot's lane: `stop` interrupts the slot's own Command under the slot's current key. */
export const slotLane = <A, E>(
	scope: string,
	slot: Keyed<A, E>,
	stop: (key: string) => Command.Command<Outcome>,
): ReadonlyArray<Lane> => {
	const { key } = slot
	return key === null ? [] : [{ scope, key, isInFlight: isInFlight(slot), stop: () => stop(key) }]
}

/** The requests in flight before a step whose key no lane after it still holds: stop each once. */
export const stopSuperseded = <M>(
	before: ReadonlyArray<Lane>,
	after: ReadonlyArray<Lane>,
	done: (outcome: Outcome) => M,
): ReadonlyArray<Command.Command<M>> => {
	const held = new Set(Array.map(after, (lane) => `${lane.scope}\n${lane.key}`))
	const stale = Array.filter(before, (lane) => lane.isInFlight && !held.has(`${lane.scope}\n${lane.key}`))
	const once = Array.dedupeWith(stale, (a, b) => a.scope === b.scope && a.key === b.key)
	return Array.map(once, (lane) => Command.mapMessage(lane.stop(), done))
}
