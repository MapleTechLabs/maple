import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchGoldenSignals, FetchOperations, FetchOverview, FetchTimeseries } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchOverview.name, model.overview, (key) => FetchOverview.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchOperations.name, model.operations, (key) =>
		FetchOperations.Interrupt({ key }, outcomeOf),
	),
	...slotLane(FetchTimeseries.name, model.timeseries, (key) =>
		FetchTimeseries.Interrupt({ key }, outcomeOf),
	),
	...slotLane(FetchGoldenSignals.name, model.golden, (key) =>
		FetchGoldenSignals.Interrupt({ key }, outcomeOf),
	),
]
