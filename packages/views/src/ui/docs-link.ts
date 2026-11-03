import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

/** A docs link under an empty state: muted text and an external-link glyph, opening in a new tab. */
export const docsLink = <M>(h: HtmlBuilder<M>, href: string, label = "Read the docs"): Html =>
	h.a(
		[
			h.Class(
				"inline-flex items-center gap-1.5 text-muted-foreground text-sm underline-offset-4 hover:text-foreground active:text-foreground hover:underline active:underline",
			),
			h.Href(href),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
		],
		[label, icon(h, "ExternalLinkIcon", { size: 12 })],
	)
