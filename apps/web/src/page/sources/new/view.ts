import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { pageTitle } from "../../../ui/page-layout"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { FlowHost, Model } from "./model"
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

const metaOf = (model: Model) =>
	model.platform !== null
		? platformMeta(model.platform)
		: model.integration !== null
			? integrationMeta(model.integration)
			: null

/** The source's mark, its title and the trail under it; `titleId` names the drawer's dialog by it. */
export const titleContent = (h: H, model: Model, titleId?: string): Html => {
	const meta = metaOf(model)
	return h.div(
		[h.Class("flex items-center gap-4")],
		[
			...(meta === null
				? []
				: [
						h.span(
							[
								h.AriaHidden(true),
								h.Class(
									"hidden size-12 shrink-0 items-center justify-center rounded-lg border bg-card sm:inline-flex",
								),
							],
							[icon(h, meta.icon, { size: 22 })],
						),
					]),
			h.div(
				[h.Class("min-w-0 space-y-2")],
				[
					// In the drawer the title is the dialog's name, under the onboarding page's own h1.
					titleId === undefined
						? pageTitle(h, { title: titleOf(model) }, [titleOf(model)])
						: pageTitle(h, { level: 2, attributes: [h.Id(titleId)] }, [titleOf(model)]),
					trail(h, model),
				],
			),
		],
	)
}

const cancel = (h: H): Html =>
	linkButton(h, { href: hrefOf(AppRoute.Sources()), size: "sm", variant: "ghost" }, ["Cancel"])

/** The current step: the token once a source exists, the push form, an integration's step, or the picker. */
export const stepBody = (h: H, model: Model, timeZone: string, host: FlowHost): Html =>
	model.created !== null
		? tokenStep(h, model, model.created, host)
		: model.platform !== null
			? createSourceForm(h, model, model.platform, host)
			: model.integration !== null
				? integrationStep(h, model, model.integration, timeZone, host)
				: platformPicker(h, model)

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(h, { titleContent: titleContent(h, model), actions: cancel(h) }, [
		stepBody(h, model, inputs.context.timeZone, "page"),
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
