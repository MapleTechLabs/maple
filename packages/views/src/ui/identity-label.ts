import type { Html, HtmlBuilder } from "foldkit/html"
import { typography } from "./typography"

// `IdentityLabel`: the name-over-detail text beside an avatar in an account or org trigger, a grid
// of truncating lines that fills the rest of the row.

/** The label's lines (the name, then an email, a region or a namespace). */
export const identityLabel = <M>(h: HtmlBuilder<M>, lines: ReadonlyArray<Html | string>): Html =>
	typography(h, { size: "sm", as: "div", className: "grid flex-1 text-left leading-tight" }, lines)
