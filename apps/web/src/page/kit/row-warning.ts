import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typographyClass } from "@maple/views/ui/typography"

/** A list row's warning: a small glyph and a few words in the warning tone, under the row's name. */
export const rowWarning = <M>(h: HtmlBuilder<M>, options: Readonly<{ icon: IconName; text: string }>): Html =>
	hstack(
		h,
		{
			gap: "1.5",
			align: "start",
			shrink: true,
			className: typographyClass({ size: "xs", tone: "warning" }),
		},
		// The glyph sits on the first line when the words wrap.
		[icon(h, options.icon, { size: 14, className: "h-lh shrink-0" }), options.text],
	)

/** A row's warnings side by side, wrapping onto more lines where the row is narrow. */
export const rowWarnings = <M>(h: HtmlBuilder<M>, warnings: ReadonlyArray<Html>): Html =>
	hstack(h, { gap: "3", align: "start", wrap: true, shrink: true, className: "gap-y-0.5" }, warnings)
