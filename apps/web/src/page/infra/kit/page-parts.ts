import type { DocsPage } from "../../../lib/docs"
import { countLabel as nounCount } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import {
	empty,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyMessage,
	emptyTitle,
} from "@maple/views/ui/empty"
import { icon } from "@maple/views/ui/icon"
import { pageTitle } from "@maple/views/ui/page-layout"
import { searchInput } from "@maple/views/ui/search-input"
import { listToolbar, toolbarCount } from "../../kit/list-toolbar"
import { docsLink } from "../../kit/signal-empty-state"
import { emptyActions } from "@maple/views/ui/signal-empty-state"
import { hstack } from "@maple/views/ui/stack"
import { spaced } from "@maple/views/ui/spaced"
import { Array as Arr } from "effect"

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

const isHtmlList = (value: Html | ReadonlyArray<Html>): value is ReadonlyArray<Html> => Arr.isArray(value)

const trailingOf = (trailing: PageHeroOptions["trailing"]): ReadonlyArray<Html> =>
	trailing === undefined ? [] : isHtmlList(trailing) ? trailing : [trailing]

/**
 * `pageHero` split for `dashboardPage`: the title, its trailing badge and the description go in the
 * header beside the time controls (one title row on every page); meta opens the body.
 */
export const pageHeroParts = <M>(
	h: HtmlBuilder<M>,
	options: Omit<PageHeroOptions, "actions" | "className">,
): Readonly<{ title: Html; body: Html }> => ({
	title: h.div(
		[h.Class("min-w-0 space-y-0.5")],
		[
			hstack(h, { gap: "3", align: "center", wrap: true, shrink: true }, [
				pageTitle(
					h,
					{
						title: typeof options.title === "string" ? options.title : undefined,
						className: "min-w-0 leading-8 text-foreground",
					},
					[options.title],
				),
				...trailingOf(options.trailing),
			]),
			...(options.description === undefined || options.description === ""
				? []
				: [
						h.p(
							[h.Class("max-w-2xl font-prose text-sm text-muted-foreground")],
							[options.description],
						),
					]),
		],
	),
	body:
		options.meta === undefined || options.meta.length === 0
			? null
			: hstack(h, { gap: "2", wrap: true }, options.meta),
})

/** `PageHero` for a page that draws its header in the body: `pageHeroParts` with actions beside it. */
export const pageHero = <M>(h: HtmlBuilder<M>, options: PageHeroOptions): Html => {
	const parts = pageHeroParts(h, options)
	return h.header(
		[h.Class(cn("flex flex-wrap items-start gap-x-6 gap-y-3", options.className))],
		[
			spaced(
				h,
				{ space: "2", fill: true },
				parts.body === null ? [parts.title] : [parts.title, parts.body],
			),
			...(options.actions === undefined || options.actions.length === 0
				? []
				: [hstack(h, { gap: "2", className: "shrink-0" }, options.actions)]),
		],
	)
}

/** The header's right side: a page's own actions before its time controls. */
export const headerActions = <M>(h: HtmlBuilder<M>, extra: ReadonlyArray<Html>, controls: Html): Html =>
	extra.length === 0 ? controls : hstack(h, { gap: "2", wrap: true }, [...extra, controls])

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

/** `SearchToolbar` over `SearchInput size="sm"` (w-64), on the shared list toolbar. */
export const searchToolbar = <M>(h: HtmlBuilder<M>, options: SearchToolbarOptions<M>): Html =>
	listToolbar(h, {
		// Parents space their sections; the list toolbar's own bottom padding would double it.
		className: cn("pb-0", options.className),
		leading: hstack(h, { gap: "2", wrap: true }, [
			searchInput(h, {
				id: options.id,
				size: "sm",
				className: "w-64",
				placeholder: options.placeholder,
				value: options.value,
				onInput: options.onInput,
				onClear: options.onClear,
			}),
			...(options.children ?? []),
		]),
		trailing:
			options.trailing === undefined || options.trailing === ""
				? []
				: [toolbarCount(h, [options.trailing])],
	})

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
	emptyMessage(h, { dashed: true, className: "py-12" }, [
		`No metrics arrived for this ${noun} in this window`,
	])

/** `countLabel`: "Top 50 of 541 pods" for a slice, "541 pods" for the whole list. */
export const countLabel = (shown: number, total: number, noun: string): string => {
	const counted = nounCount(total, noun)
	return total > shown ? `Top ${shown} of ${counted}` : counted
}
