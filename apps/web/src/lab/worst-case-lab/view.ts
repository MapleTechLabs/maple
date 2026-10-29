import type { Html, HtmlBuilder } from "foldkit/html"
import { labRoot } from "../toasts"
import { Message, type Model } from "./model"
import { errorsSection } from "./view-errors"
import { miscSection, tablesSection } from "./view-misc"
import { formattersSection, infraSection, modeToggle } from "./view-parts"
import { legendSection, traceSection, verdictSection } from "./view-sections"

/** `WorstCaseLab`: existing components over worst-case fixtures, with a demo twin. */
const page = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("mx-auto max-w-6xl space-y-10 p-8 pb-24"), h.DataAttribute("wc-mode", model.mode)],
		[
			formattersSection(h, model),
			infraSection(h, model),
			traceSection(h, model),
			legendSection(h, model),
			verdictSection(h, model),
			errorsSection(h, model),
			tablesSection(h, model),
			miscSection(h, model),
			modeToggle(h, model),
		],
	)

export const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	labRoot(h, model.toasts, (message) => Message.GotToastMessage({ message }), page(model, h))
