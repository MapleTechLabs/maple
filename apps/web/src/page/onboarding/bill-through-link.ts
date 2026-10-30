import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"

/** Under the plan picker: an org another org pays for links itself in billing settings instead. */
export const billThroughAnotherOrgLink = <M>(h: HtmlBuilder<M>): Html =>
	h.p(
		[h.Class("text-center text-xs text-muted-foreground")],
		[
			"Billed through another organization? ",
			h.a(
				[
					h.Href(hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))),
					h.Class("text-foreground underline-offset-4 hover:underline"),
				],
				["Link it in billing settings"],
			),
		],
	)
