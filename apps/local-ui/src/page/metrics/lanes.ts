import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchList, FetchSparklines, FetchSummary } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchList.name, model.list, (key) => FetchList.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchSummary.name, model.summary, (key) => FetchSummary.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchSparklines.name, model.sparklines, (key) =>
		FetchSparklines.Interrupt({ key }, outcomeOf),
	),
]
