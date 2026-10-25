import type { DocsPage } from "../../../lib/docs"
import { countLabel as nounCount } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyMessage, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { searchInput } from "../../../ui/search-input"
import { docsLink, emptyActions } from "../../kit/signal-empty-state"

// `PageHero`, `SearchToolbar` and the infra empty states.

type Children = ReadonlyArray<Html | string>

export type PageHeroOptions = Readonly<{
	title: Html | string
	description?: Html | string
	meta?: Children
	actions?: Children
	/** Beside the title: a status badge. */
	trailing?: Html | ReadonlyArray<Html>
	className?: string
}>

const isHtmlList = (value: Html | ReadonlyArray<Html>): value is ReadonlyArray<Html> => Array.isArray(value)

const trailingOf = (trailing: PageHeroOptions["trailing"]): ReadonlyArray<Html> =>
	trailing === undefined ? [] : isHtmlList(trailing) ? trailing : [trailing]

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
							...trailingOf(options.trailing),
						],
					),
					...(options.description === undefined || options.description === ""
						? []
						: [h.p([h.Class("max-w-2xl font-prose text-sm text-muted-foreground")], [options.description])]),
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
	placeholder: string
	onInput: (value: string) => M
	onClear: M
	/** Controls beside the search: a kind pivot, a sort menu. */
	children?: ReadonlyArray<Html>
	trailing?: string
	className?: string
}>

/** `SearchToolbar` over `SearchInput size="default"` (w-64). */
export const searchToolbar = <M>(h: HtmlBuilder<M>, options: SearchToolbarOptions<M>): Html =>
	h.div(
		[h.Class(cn("flex flex-wrap items-center justify-between gap-3", options.className))],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					searchInput(h, {
						id: options.id,
						size: "default",
						className: "w-64",
						placeholder: options.placeholder,
						value: options.value,
						onInput: options.onInput,
						onClear: options.onClear,
					}),
					...(options.children ?? []),
				],
			),
			...(options.trailing === undefined || options.trailing === ""
				? []
				: [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [options.trailing])]),
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

/** `NoMetricsMessage`. */
export const noMetricsMessage = <M>(h: HtmlBuilder<M>, noun: string): Html =>
	emptyMessage(h, { dashed: true, className: "py-12" }, [`No metrics arrived for this ${noun} in the selected window.`])

/** `countLabel`: "Top 50 of 541 pods" for a slice, "541 pods" for the whole list. */
export const countLabel = (shown: number, total: number, noun: string): string => {
	const counted = nounCount(total, noun)
	return total > shown ? `Top ${shown} of ${counted}` : counted
}
