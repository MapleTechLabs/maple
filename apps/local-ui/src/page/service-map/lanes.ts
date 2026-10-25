import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchServiceMap } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchServiceMap.name, model.data, (key) => FetchServiceMap.Interrupt({ key }, outcomeOf)),
]
