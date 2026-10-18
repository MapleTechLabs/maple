import type { DocsPage } from "@maple/web/lib/docs"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { button, linkButton } from "../../../ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { docsLink } from "../../kit/signal-empty-state"

// `IntegrationNotConnected` (components/infra/primitives/integration-not-connected.tsx) and
// `FilteredEmpty` (components/common/filtered-empty.tsx).

type ButtonVariant = Parameters<typeof button>[1]["variant"]

/** `EmptyActions`: the action row under an empty state. */
export const emptyActions = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class("flex flex-wrap items-center justify-center gap-x-4 gap-y-2")], children)

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

export type FilteredEmptyOptions<M> = Readonly<{
	noun: string
	title?: string
	description?: string
	onClear?: M
	clearLabel?: string
	icon?: Html
	className?: string
}>

export const filteredEmpty = <M>(h: HtmlBuilder<M>, options: FilteredEmptyOptions<M>): Html => {
	const description =
		options.description ?? "Everything in this time range was excluded by the current filters."
	return empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [options.icon ?? icon(h, "SlidersIcon")]),
				emptyTitle(h, [options.title ?? `No ${options.noun} match these filters`]),
				...(description === "" ? [] : [emptyDescription(h, [description])]),
			]),
			...(options.onClear === undefined
				? []
				: [
						emptyContent(h, [
							button(
								h,
								{ variant: "outline", size: "sm", attributes: [h.OnClick(options.onClear)] },
								[options.clearLabel ?? "Clear filters"],
							),
						]),
					]),
		],
		options.className,
	)
}
