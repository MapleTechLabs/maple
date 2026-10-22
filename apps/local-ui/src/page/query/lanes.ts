import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchTables, RunQuery } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`): the tables and the current run. */
export const lanes = (model: Model): ReadonlyArray<Lane> => {
	const { run } = model
	const running: ReadonlyArray<Lane> =
		run._tag === "Running"
			? [{ scope: RunQuery.name, key: String(run.id), isInFlight: true, stop: () => RunQuery.Interrupt({ id: run.id }, outcomeOf) }]
			: []
	return [...slotLane(FetchTables.name, model.tables, (key) => FetchTables.Interrupt({ key }, outcomeOf)), ...running]
}
