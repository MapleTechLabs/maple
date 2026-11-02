import { cn } from "@maple/ui/lib/utils"
import {
	pageDescriptionStyles,
	pageHeaderActionsStyles,
	pageHeaderStyles,
	pageHeaderTextStyles,
	pageLayoutStyles,
	pageTitleStyles,
} from "@maple/ui/styles/ui/page-layout"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

// Port of the header half of packages/ui/src/components/ui/page-layout.tsx (Root, Header, Title,
// Description, HeaderActions). The sticky area, sidebars and sheets belong to the app shell port.

type Children = ReadonlyArray<Html | string>

export const pageLayoutRoot = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div([h.DataAttribute("slot", "page-layout"), h.Class(cn(pageLayoutStyles, className))], children)

/** `PageLayout.Title`: the one canonical page `<h1>`; `title` is the native tooltip when it truncates. */
export const pageTitle = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly title?: string
		readonly className?: string
		/** Behaviour on the heading itself (an inline-editable title's click to rename). */
		readonly attributes?: ReadonlyArray<Attribute<M>>
		/** `2` when the page title sits under another page's `h1` (a flow in a drawer). */
		readonly level?: 1 | 2
	},
	children: Children,
): Html => {
	const attributes = [
		h.DataAttribute("slot", "page-title"),
		h.Class(cn(pageTitleStyles, options.className)),
		...(options.title === undefined ? [] : [h.Title(options.title)]),
		...(options.attributes ?? []),
	]
	return options.level === 2 ? h.h2(attributes, children) : h.h1(attributes, children)
}

export const pageDescription = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.p(
		[h.DataAttribute("slot", "page-description"), h.Class(cn(pageDescriptionStyles, className))],
		children,
	)

export interface PageHeaderOptions {
	readonly title?: string
	readonly titleContent?: Html
	readonly description?: string
	readonly className?: string
}

/** `PageLayout.Header`; renders nothing (`null`) when it has no content. */
export const pageHeader = <M>(
	h: HtmlBuilder<M>,
	options: PageHeaderOptions,
	children: Children = [],
): Html => {
	const title = options.title ?? ""
	const description = options.description ?? ""
	if (title === "" && options.titleContent === undefined && description === "" && children.length === 0) {
		return null
	}
	return h.div(
		[h.DataAttribute("slot", "page-header"), h.Class(cn(pageHeaderStyles, options.className))],
		[
			h.div(
				[h.Class(pageHeaderTextStyles)],
				[
					...(options.titleContent !== undefined
						? [options.titleContent]
						: title !== ""
							? [pageTitle(h, { title }, [title])]
							: []),
					...(description !== "" ? [pageDescription(h, [description])] : []),
				],
			),
			...children,
		],
	)
}

export const pageHeaderActions = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.div(
		[h.DataAttribute("slot", "page-header-actions"), h.Class(cn(pageHeaderActionsStyles, className))],
		children,
	)
