import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"

// `PageHero` and `HeroChip` (apps/web/src/components/common/page-hero.tsx).

type Children = ReadonlyArray<Html | string>

export type PageHeroOptions = Readonly<{
	title: Html | string
	description?: Html | string
	meta?: Children
	actions?: Children
	trailing?: Html
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
							...(options.trailing === undefined ? [] : [options.trailing]),
						],
					),
					...(options.description === undefined || options.description === ""
						? []
						: [h.p([h.Class("max-w-2xl text-sm text-muted-foreground")], [options.description])]),
					...(options.meta === undefined || options.meta.length === 0
						? []
						: [h.div([h.Class("mt-2 flex flex-wrap items-center gap-2")], options.meta)]),
				],
			),
			...(options.actions === undefined || options.actions.length === 0
				? []
				: [h.div([h.Class("flex shrink-0 items-center gap-2")], options.actions)]),
		],
	)

/** `HeroChip` with plain-text children (several parts stay several text nodes): the text is its title. */
export const heroChip = <M>(
	h: HtmlBuilder<M>,
	text: string | ReadonlyArray<string>,
	title?: string,
): Html => {
	const parts = typeof text === "string" ? [text] : text
	return badge(
		h,
		{
			variant: "meta",
			size: "xs",
			mono: true,
			className: "min-w-0",
			attributes: [h.Title(title ?? parts.join(""))],
		},
		[h.span([h.Class("min-w-0 truncate")], parts)],
	)
}
