import type { DocsPage } from "../../../lib/docs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"

// `IntegrationNotConnected`.

type ButtonVariant = Parameters<typeof button>[1]["variant"]

export type IntegrationLinkActionsOptions = Readonly<{
	/** The `/integrations?integration=` id the button opens. */
	integration: string
	actionLabel: string
	actionVariant?: ButtonVariant
	docsPage?: DocsPage
}>

/** `IntegrationLinkActions`: the integration-page button plus an optional docs link. */
export const integrationLinkActions = <M>(h: HtmlBuilder<M>, options: IntegrationLinkActionsOptions): Html =>
	emptyActions(h, [
		linkButton(
			h,
			{
				size: "sm",
				variant: options.actionVariant,
				href: hrefOf(AppRoute.Integrations({ search: { integration: options.integration } })),
			},
			[options.actionLabel],
		),
		...(options.docsPage === undefined ? [] : [docsLink(h, options.docsPage)]),
	])

export type IntegrationNotConnectedOptions = IntegrationLinkActionsOptions &
	Readonly<{
		icon: Html
		title: string
		description: string
	}>

export const integrationNotConnected = <M>(
	h: HtmlBuilder<M>,
	options: IntegrationNotConnectedOptions,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [options.icon]),
				emptyTitle(h, [options.title]),
				emptyDescription(h, [options.description]),
			]),
			emptyContent(h, [integrationLinkActions(h, options)]),
		],
		"py-16",
	)
