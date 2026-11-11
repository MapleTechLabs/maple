import type { Html, HtmlBuilder } from "foldkit/html"
import { resourceNotFound } from "../../kit/resource-not-found"
import { statusPagesHref } from "./commands"

/** No status page has this id: the editor's and the viewer's not-found, with a way back to the list. */
export const statusPageNotFound = <M>(h: HtmlBuilder<M>, rawPageId: string): Html =>
	resourceNotFound(h, {
		title: "Status page not found",
		description: ["No status page has the id ", h.code([h.Class("font-mono")], [rawPageId]), "."],
		back: { href: statusPagesHref(), label: "Back to status pages" },
	})
