import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { Model } from "./model"
import { createSourceForm } from "./view-form"
import { platformPicker } from "./view-picker"
import { tokenStep } from "./view-token"

// `NewSourcePage`.

type H = HtmlBuilder<Message>

export const stepOf = (model: Model): 1 | 2 | 3 => (model.created !== null ? 3 : model.platform !== null ? 2 : 1)

const STEP_LABELS = { 1: "Pick what sends the data", 2: "Name it", 3: "Send data" } as const

const titleContent = (h: H, model: Model): Html => {
	const step = stepOf(model)
	return h.div(
		[h.Class("space-y-1")],
		[
			h.h1([h.Class("font-display text-2xl font-medium tracking-tight")], ["Connect a source"]),
			h.p([h.Class("text-muted-foreground text-sm")], ["Step ", String(step), " of 3 ·", " ", STEP_LABELS[step]]),
		],
	)
}

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, _inputs, h) =>
	dashboardPage(h, { titleContent: titleContent(h, model) }, [
		model.created !== null
			? tokenStep(h, model, model.created)
			: model.platform !== null
				? createSourceForm(h, model, model.platform)
				: platformPicker(h),
	]),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Sources", href: hrefOf(AppRoute.Sources()) },
	{ label: model.platform !== null ? platformMeta(model.platform).label : "Connect source" },
]
