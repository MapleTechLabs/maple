import { ServiceMapBlock } from "@maple/web/service-map/map/block"
import * as CopyButton from "@maple/web/ui/copy-button"
import type { Block } from "foldkit"
import { SaveLayout, SaveViewPrefs } from "./command"
import { ServiceMapPageDefinition } from "./definition"

const { makeCommandsStep } = ServiceMapPageDefinition

/**
 * The map, created once the rows and the stored state are in. `onLayoutChange` /
 * `onViewPrefsChange` write localStorage whenever its drags, cameras or declutter prefs moved.
 */
export const MapBinding = ServiceMapPageDefinition.makeBinding(ServiceMapBlock, {
	field: "maybeMap",
}).withOutMessagePolicy({
	fold: ServiceMapPageDefinition.makeOutMessageFold(ServiceMapBlock, {
		ChangedMapState: ({
			isPrefsChanged,
			isLayoutChanged,
			minTrafficPct,
			collapsedNamespaces,
			snapshots,
		}) =>
			makeCommandsStep(() => [
				...(isPrefsChanged ? [SaveViewPrefs({ prefs: { minTrafficPct, collapsedNamespaces } })] : []),
				...(isLayoutChanged ? [SaveLayout({ snapshots })] : []),
			]),
	}),
})

/** The empty state's connect guide: the endpoint field's copy button and the env block's. */
export const GuideEndpointCopyBinding = ServiceMapPageDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "guideEndpointCopy",
})
export const GuideEnvCopyBinding = ServiceMapPageDefinition.makeBinding(CopyButton.CopyButtonBlock, {
	field: "guideEnvCopy",
})

export const ServiceMapPageComposition = ServiceMapPageDefinition.makeComposition({
	bindings: [MapBinding, GuideEndpointCopyBinding, GuideEnvCopyBinding],
})
export type ServiceMapPageViewBuilder = Block.ViewBuilderFor<typeof ServiceMapPageComposition>
