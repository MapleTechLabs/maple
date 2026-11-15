import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { hstack } from "@maple/views/ui/stack"
import { typographyClass } from "@maple/views/ui/typography"

/** A list row's warning that a rule has no destination: its incidents open, and nobody is told. */
export const notifiesNoOne = <M>(h: HtmlBuilder<M>): Html =>
	hstack(h, { gap: "1.5", align: "center", className: typographyClass({ size: "xs", tone: "warning" }) }, [
		icon(h, "BellSlashIcon", { size: 14 }),
		"Notifies no one",
	])
