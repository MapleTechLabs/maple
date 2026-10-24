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
import { integrationStep } from "./view-integration"
import { integrationMeta, platformPicker } from "./view-picker"
import { tokenStep } from "./view-token"
import { trail } from "./view-trail"

// `NewSourcePage`.

type H = HtmlBuilder<Message>

const titleOf = (model: Model): string =>
	model.platform !== null
		? `Connect ${platformMeta(model.platform).label}`
		: model.integration !== null
			? `Connect ${integrationMeta(model.integration).label}`
			: "Connect a source"

const titleContent = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			h.h1([h.Class("font-display text-2xl font-medium tracking-tight")], [titleOf(model)]),
			trail(h, model),
		],
	)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(h, { titleContent: titleContent(h, model) }, [
		model.created !== null
			? tokenStep(h, model, model.created)
			: model.platform !== null
				? createSourceForm(h, model, model.platform)
				: model.integration !== null
					? integrationStep(h, model, model.integration, inputs.context.timeZone)
					: platformPicker(h, model),
	]),
)

export const breadcrumbsOf = (model: Model): ReadonlyArray<BreadcrumbEntry> => [
	{ label: "Sources", href: hrefOf(AppRoute.Sources()) },
	{
		label:
			model.platform !== null
				? platformMeta(model.platform).label
				: model.integration !== null
					? integrationMeta(model.integration).label
					: "Connect source",
	},
]
