import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchBreakdown, FetchEntry, FetchTimeseries } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchEntry.name, model.entry, (key) => FetchEntry.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchTimeseries.name, model.timeseries, (key) => FetchTimeseries.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchBreakdown.name, model.breakdown, (key) => FetchBreakdown.Interrupt({ key }, outcomeOf)),
]
