import type { Html, HtmlBuilder } from "foldkit/html"
import { FLOW_ICONS, type FlowIconName } from "../../ui/flow-icons"
import { type IconOptions, iconNode } from "../../ui/icon"

/** `icon` over the flow's own trees, so the flow does not pull in every icon. */
export const flowIcon = <M>(h: HtmlBuilder<M>, name: FlowIconName, options: IconOptions<M> = {}): Html =>
	iconNode(h, FLOW_ICONS[name], name, options)
