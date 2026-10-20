import { type Lane, outcomeOf, slotLane } from "../../data/lanes"
import { FetchDetail, FetchTraces, FetchTranscript } from "./command"
import type { Model } from "./model"

/** The requests this page may have in flight (see `data/lanes.ts`). */
export const lanes = (model: Model): ReadonlyArray<Lane> => [
	...slotLane(FetchDetail.name, model.detail, (key) => FetchDetail.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchTranscript.name, model.transcript, (key) => FetchTranscript.Interrupt({ key }, outcomeOf)),
	...slotLane(FetchTraces.name, model.traces, (key) => FetchTraces.Interrupt({ key }, outcomeOf)),
]
