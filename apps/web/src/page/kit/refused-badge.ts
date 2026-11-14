import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"

/** The mark on an audit entry that did not go through: a crossed circle and what happened ("Denied", "Failed"). */
export const refusedBadge = <M>(h: HtmlBuilder<M>, label: string): Html =>
	badge(h, { variant: "crit", size: "sm", className: "shrink-0" }, [icon(h, "CircleXmarkIcon"), label])
