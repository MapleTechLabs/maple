import type { DocsPage } from "@maple/web/lib/docs"
import { countLabel as nounCount } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { inputGroup, inputGroupAddon, inputGroupButton, inputGroupInput } from "../../../ui/input-group"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"

// `PageHero` (common/page-hero.tsx), `SearchToolbar` (common/search-toolbar.tsx) and the infra
// empty states.

export type PageHeroOptions = Readonly<{
	title: Html | string
	description?: Html | string
	meta?: ReadonlyArray<Html>
	actions?: ReadonlyArray<Html>
	trailing?: ReadonlyArray<Html>
	className?: string
}>

export const pageHero = <M>(h: HtmlBuilder<M>, options: PageHeroOptions): Html =>
	h.header(
		[h.Class(cn("flex flex-wrap items-start gap-x-6 gap-y-3", options.className))],
		[
			h.div(
				[h.Class("min-w-0 flex-1 space-y-1")],
				[
					h.div(
						[h.Class("flex flex-wrap items-baseline gap-3")],
						[
							h.h1(
								[
									h.Class(
										"font-display text-2xl font-semibold leading-[1.1] tracking-tight text-foreground",
									),
								],
								[options.title],
							),
							...(options.trailing ?? []),
						],
					),
					...(options.description === undefined
						? []
						: [h.p([h.Class("max-w-2xl text-sm text-muted-foreground")], [options.description])]),
					...(options.meta === undefined
						? []
						: [h.div([h.Class("mt-2 flex flex-wrap items-center gap-2")], options.meta)]),
				],
			),
			...(options.actions === undefined || options.actions.length === 0
				? []
				: [h.div([h.Class("flex shrink-0 items-center gap-2")], options.actions)]),
		],
	)

export type SearchToolbarOptions<M> = Readonly<{
	id: string
	value: string
	onChange: (value: string) => M
	placeholder: string
	trailing?: string
	/** Controls beside the search (a kind pivot). */
	children?: ReadonlyArray<Html>
	className?: string
}>

/** `SearchToolbar` over `SearchInput size="default"` (w-64), with its clear button. */
export const searchToolbar = <M>(h: HtmlBuilder<M>, options: SearchToolbarOptions<M>): Html =>
	h.div(
		[h.Class(cn("flex flex-wrap items-center justify-between gap-3", options.className))],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					inputGroup(h, { className: "w-64" }, [
						inputGroupAddon(h, {}, [icon(h, "MagnifierIcon")]),
						inputGroupInput(h, {
							id: options.id,
							size: "default",
							type: "text",
							attributes: [
								h.Placeholder(options.placeholder),
								h.Value(options.value),
								h.OnInput(options.onChange),
							],
						}),
						...(options.value === ""
							? []
							: [
									inputGroupAddon(h, { align: "inline-end" }, [
										inputGroupButton(
											h,
											{
												attributes: [
													h.AriaLabel("Clear search"),
													h.OnClick(options.onChange("")),
												],
											},
											[icon(h, "XmarkIcon")],
										),
									]),
								]),
					]),
					...(options.children ?? []),
				],
			),
			...(options.trailing
				? [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [options.trailing])]
				: []),
		],
	)

/** `InfraSetupEmpty`: nothing reporting yet; the button opens the page's install modal. */
export const setupEmpty = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		icon: Html
		title: string
		description: string
		actionLabel: string
		onAction: M
		docs: DocsPage
		extra?: ReadonlyArray<Html>
		/** The empty state's own install modal (`mountedView`), when the page has none of its own. */
		modal?: Html
	}>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [options.icon]),
				emptyTitle(h, [options.title]),
				emptyDescription(h, [options.description]),
			]),
			emptyActions(h, [
				button(h, { size: "sm", attributes: [h.OnClick(options.onAction)] }, [
					icon(h, "PlusIcon"),
					options.actionLabel,
				]),
				docsLink(h, options.docs),
				...(options.extra ?? []),
			]),
			...(options.modal === undefined ? [] : [options.modal]),
		],
		"py-16",
	)

/** `NoMetricsMessage` (primitives/no-metrics-message.tsx). */
export const noMetricsMessage = <M>(h: HtmlBuilder<M>, noun: string): Html =>
	emptyMessage(h, { dashed: true, className: "py-12" }, [`No metrics arrived for this ${noun} in the selected window.`])

/** `countLabel`: "Top 50 of 541 pods" for a slice, "541 pods" for the whole list. */
export const countLabel = (shown: number, total: number, noun: string): string => {
	const counted = nounCount(total, noun)
	return total > shown ? `Top ${shown} of ${counted}` : counted
}
