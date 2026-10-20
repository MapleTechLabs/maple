import { Option } from "effect"
import { AsyncData } from "foldkit"

// A kept tab coming back: its loaded data stays on screen while it reads again (`revalidateOrLoad`).

/** One data field on re-entry: its next state, and `read` unless a read is already in flight. */
export const revisitData = <A, E, C>(data: AsyncData.AsyncData<A, E>, read: () => C) =>
	Option.match(AsyncData.revalidateOrLoad(data), {
		onNone: () => ({ data, commands: [] }),
		onSome: (next) => ({ data: next, commands: [read()] }),
	})
