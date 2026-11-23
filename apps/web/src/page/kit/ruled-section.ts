import type { Html, HtmlBuilder } from "foldkit/html"
import { vstack } from "@maple/views/ui/stack"

// A section set off from the content above it by a full-width rule, its children stacked 12px apart.

export const ruledSection = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	vstack(h, { gap: "3", className: "border-t border-border pt-5" }, children)
