import * as Policy from "@maple/domain/policy"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import type { BreadcrumbEntry } from "../../../shell"
import type { PageViewInputs } from "../../contract"
import { dashboardPage } from "../../kit/dashboard-page"
import { linkButton } from "@maple/views/ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { skeleton } from "@maple/views/ui/skeleton"
import { pageTitle } from "@maple/views/ui/page-layout"
import { platformMeta } from "../kit/platforms"
import { Message } from "./message"
import type { FlowHost, Model } from "./model"
import { createSourceForm } from "./view-form"
import { integrationStep } from "./view-integration"
import { integrationMeta, platformPicker } from "./view-picker"
import { tokenStep } from "./view-token"
import { trail } from "./view-trail"
import { hstack } from "@maple/views/ui/stack"

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
	return hstack(h, { gap: "4" }, [
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
	])
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

/** A member without `sources:manage` reaching the page by URL: what they can do instead. */
const notPermitted = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "ConnectionIcon", { size: 16 })]),
				emptyTitle(h, ["Only org admins and engineers can connect sources"]),
				emptyDescription(h, [
					"Ask one of them to connect it, or browse the sources already sending data.",
				]),
			]),
			linkButton(h, { href: hrefOf(AppRoute.Sources()), size: "sm", variant: "outline" }, [
				"View sources",
			]),
		],
		"py-8",
	)

const isRefused = (model: Model): boolean =>
	model.grants !== null && !Policy.has(model.grants, "sources:manage")

const pageBody = (h: H, model: Model, timeZone: string): Html =>
	model.grants === null
		? skeleton(h, "h-48 w-full")
		: isRefused(model)
			? notPermitted(h)
			: stepBody(h, model, timeZone, "page")

export const view = Submodel.defineView<Model, Message, PageViewInputs>((model, inputs, h) =>
	dashboardPage(
		h,
		// A member has no steps to take, so no trail either.
		isRefused(model)
			? { title: titleOf(model), actions: cancel(h) }
			: { titleContent: titleContent(h, model), actions: cancel(h) },
		[pageBody(h, model, inputs.context.timeZone)],
	),
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
