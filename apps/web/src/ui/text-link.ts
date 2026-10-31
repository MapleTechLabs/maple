import { cn } from "@maple/ui/lib/utils"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

// `TextLink`: an inline action that reads as a link inside running text or a card footer, with no
// button box. `primary` is a call to action ("View all →"), `muted` a quiet secondary action
// ("Clear filters", "Show 4 more"). An `href` renders an anchor, an `onClick` a button.

export type TextLinkTone = "primary" | "muted"

const BASE =
	"inline-flex cursor-pointer items-center gap-1 underline-offset-2 hover:underline active:underline focus-visible:rounded-xs focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"

const TONE = {
	primary: "font-medium text-primary",
	muted: "text-muted-foreground hover:text-foreground active:text-foreground",
} as const satisfies Record<TextLinkTone, string>

export type TextLinkOptions<M> = Readonly<
	{
		tone?: TextLinkTone
		/** Monospace, for links that sit among IDs and attribute values. */
		isMono?: boolean
		className?: string
		attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
	} & (
		| { href: string; onClick?: never; isDisabled?: never }
		| { onClick: M; isDisabled?: boolean; href?: never }
	)
>

export const textLinkClass = (tone: TextLinkTone = "primary", isMono = false, className?: string): string =>
	cn(BASE, TONE[tone], isMono && "font-mono", className)

export const textLink = <M>(
	h: HtmlBuilder<M>,
	options: TextLinkOptions<M>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const className = h.Class(textLinkClass(options.tone, options.isMono, options.className))
	const extra = options.attributes ?? []
	if (options.href !== undefined) return h.a([className, h.Href(options.href), ...extra], children)
	return h.button(
		[
			h.Type("button"),
			className,
			h.OnClick(options.onClick),
			...((options.isDisabled ?? false) ? [h.Disabled(true)] : []),
			...extra,
		],
		children,
	)
}
