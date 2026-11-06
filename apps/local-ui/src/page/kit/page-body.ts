import { spinner } from "@maple/views/ui/spinner"
import { hstack } from "@maple/views/ui/stack"
import type { Html, HtmlBuilder } from "foldkit/html"

// A page body's first load under its header or toolbar; the body itself is the kit's `scrollRegion`.

/** `loadingFill`: a spinner centred in the area it fills, for a body's first load. */
export const loadingFill = <M>(h: HtmlBuilder<M>): Html =>
	hstack(h, { justify: "center", className: "h-full" }, [spinner(h)])
