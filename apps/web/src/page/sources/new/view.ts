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
import { integrationStep, isIntegrationConnected } from "./view-integration"
import { integrationMeta, platformPicker } from "./view-picker"
import { tokenStep } from "./view-token"

// `NewSourcePage`.

type H = HtmlBuilder<Message>

export const stepOf = (model: Model): 1 | 2 | 3 =>
	model.created !== null
		? 3
		: model.platform !== null
			? 2
			: model.integration !== null
				? isIntegrationConnected(model, model.integration)
					? 3
					: 2
				: 1

const STEP_LABELS = { 1: "Pick what sends the data", 2: "Name it", 3: "Send data" } as const

const stepLabel = (model: Model, step: 1 | 2 | 3): string =>
	model.integration === null || step === 1
		? STEP_LABELS[step]
		: step === 2
			? `Connect ${integrationMeta(model.integration).label}`
			: "Collecting"

const titleContent = (h: H, model: Model): Html => {
	const step = stepOf(model)
	return h.div(
		[h.Class("space-y-1")],
		[
			h.h1([h.Class("font-display text-2xl font-medium tracking-tight")], ["Connect a source"]),
			h.p(
				[h.Class("text-muted-foreground text-sm")],
				["Step ", String(step), " of 3 ·", " ", stepLabel(model, step)],
			),
		],
	)
}

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
