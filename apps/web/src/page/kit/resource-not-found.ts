import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../ui/button"
import { empty, emptyDescription, emptyHeader, emptyTitle } from "../../ui/empty"
import { icon } from "../../ui/icon"

export const resourceNotFound = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		title: string
		/** Text, or text with inline markup (a mono id). */
		description?: string | ReadonlyArray<Html | string>
		/** `icon`: the media tile's glyph, at the icon's own size (default: the warning at 18). */
		icon?: Html
		back?: Readonly<{ href: string; label: string }>
		className?: string
	}>,
): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				// One plain tile; a page-level title, between the error card's and the page H1.
				h.div(
					[
						h.AriaHidden(true),
						h.Class(
							"mb-4 flex size-9 items-center justify-center rounded-md border bg-card/50 text-muted-foreground",
						),
					],
					[options.icon ?? icon(h, "CircleWarningIcon", { size: 18 })],
				),
				emptyTitle(h, [options.title], "font-display text-lg font-semibold tracking-tight"),
				...(options.description === undefined
					? []
					: [
							emptyDescription(
								h,
								typeof options.description === "string"
									? [options.description]
									: options.description,
								"text-ui",
							),
						]),
			]),
			...(options.back === undefined
				? []
				: [
						linkButton(h, { variant: "outline", size: "sm", href: options.back.href }, [
							options.back.label,
						]),
					]),
		],
		cn("md:py-12", options.className),
	)
