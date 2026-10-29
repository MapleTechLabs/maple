import { ChartBlock } from "../../../../charts/chart"
import { MountLinkedCursor } from "../../../../charts/linked-cursor"
import { ResolveThemeColors } from "../../../../charts/theme-colors"
import { MountNetworkAutoRetry } from "../../../../ui/error-state"
import type { Block } from "foldkit"
import * as Frame from "../../kit/frame"
import { MetaRowCopiesBlock } from "../../kit/resource-attributes"
import { RelayResolvedWindow } from "./command"
import { HostDetailDefinition, makeStep } from "./definition"
import { navigate } from "./navigate"

/**
 * The time frame, built by `init` with the page scope. A resolved window is relayed back as
 * `ResolvedFrameWindow` (the fold cannot read the org); a new time search navigates.
 */
export const FrameBinding = HostDetailDefinition.makeBinding(Frame.FrameBlock, {
	field: "frame",
	init: false,
}).withOutMessagePolicy({
	fold: HostDetailDefinition.makeOutMessageFold(Frame.FrameBlock, {
		ResolvedWindow: ({ mode }) =>
			makeStep((model) => ({ model, commands: [RelayResolvedWindow({ mode })] })),
		ChangedTimeSearch: ({ search }) =>
			makeStep((model) => navigate(model, { ...model.search, ...search })),
	}),
})

/** One chart per metric strip, keyed by metric. */
export const ChartsBinding = HostDetailDefinition.makeMapBinding(ChartBlock, { field: "charts" })

/** The resource attribute rows' copy buttons. */
export const CopiesBinding = HostDetailDefinition.makeBinding(MetaRowCopiesBlock, { field: "copies" })

export const HostDetailComposition = HostDetailDefinition.makeComposition({
	bindings: [FrameBinding, ChartsBinding, CopiesBinding],
	mounts: [ResolveThemeColors, MountLinkedCursor, MountNetworkAutoRetry],
})
export type HostDetailViewBuilder = Block.ViewBuilderFor<typeof HostDetailComposition>
