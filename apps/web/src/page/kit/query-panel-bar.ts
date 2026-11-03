import type { Html, HtmlBuilder } from "foldkit/html"
import { hstack } from "@maple/views/ui/stack"

/** A query panel's header bar on the sunken wash: its collapse toggle, query badge, source and actions. */
export const queryPanelBar = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "2", className: "px-3 py-2 bg-surface-sunken" }, children)
