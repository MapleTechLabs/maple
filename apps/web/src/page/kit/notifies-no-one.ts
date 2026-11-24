import type { Html, HtmlBuilder } from "foldkit/html"
import { rowWarning } from "./row-warning"

/** A list row's warning that a rule has no destination: its incidents open, and nobody is told. */
export const notifiesNoOne = <M>(h: HtmlBuilder<M>): Html =>
	rowWarning(h, { icon: "BellSlashIcon", text: "Notifies no one" })
