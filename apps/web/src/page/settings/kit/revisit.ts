import { AsyncData } from "foldkit"

// A kept tab coming back: what it showed stays on screen while it reads again.

/**
 * One data field on re-entry: loaded data revalidates (`Refreshing`), a failure stays up while it
 * retries, a cold field loads; a read already in flight is not asked twice.
 */
export const revisitData = <A, E, C>(data: AsyncData.AsyncData<A, E>, read: () => C) => {
	switch (data._tag) {
		case "Loading":
		case "Refreshing":
			return { data, commands: [] }
		case "Idle":
			return { data: AsyncData.Loading(), commands: [read()] }
		case "Failure":
			return { data, commands: [read()] }
		case "Success":
		case "Stale":
			return { data: AsyncData.Refreshing({ data: data.data }), commands: [read()] }
	}
}
