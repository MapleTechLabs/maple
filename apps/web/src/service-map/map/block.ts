import { Block } from "foldkit"
import {
	EffectsLayer,
	init,
	Model,
	operations,
	ServiceMapComposition,
	subscriptions,
	update,
} from "./service-map"
import { view } from "./view"

// The completed service map. Hosts bind `ServiceMapBlock`, fold `ChangedMapState`, and call its
// operations (`informOfSource`, `informOfFocus`, `informOfPick`, `requestCloseDetail`,
// `requestFocusSelected`) instead of building map Messages.

const prepare = () =>
	ServiceMapComposition.prepareBlock({
		init,
		update,
		view,
		subscriptions,
		operations,
		EffectsLayer,
	})
export const ServiceMapBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
