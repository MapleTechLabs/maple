import type { Html, HtmlBuilder } from "foldkit/html"
import { hstack } from "@maple/views/ui/stack"

/** A panel's filter row above its list: selects, a search field and a clear button, wrapping, ruled below. */
export const panelToolbar = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "2", align: "center", wrap: true, className: "border-b px-4 py-2.5" }, children)
