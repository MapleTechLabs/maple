import { cn } from "@maple/ui/lib/utils"
import { avatarFallbackStyles, avatarStyles } from "@maple/ui/styles/ui/avatar"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { kbdGroupStyles, kbdStyles } from "@maple/ui/styles/ui/kbd"
import { separatorStyles } from "@maple/ui/styles/ui/separator"
import type { VariantProps } from "class-variance-authority"
import type { Html, HtmlBuilder } from "foldkit/html"

type Children = ReadonlyArray<Html | string>

/** `<Kbd>`. */
export const kbd = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html => h.kbd([h.Class(cn(kbdStyles, className)), h.DataAttribute("slot", "kbd")], children)

/** `<KbdGroup>`. */
export const kbdGroup = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html => h.kbd([h.Class(cn(kbdGroupStyles, className)), h.DataAttribute("slot", "kbd-group")], children)

export type BadgeOptions = VariantProps<typeof badgeVariants> &
	Readonly<{ className?: string; style?: Readonly<Record<string, string>> }>

/** `<Badge>`: the same `badgeVariants` call, className folded in by cva. */
export const badge = <Message>(h: HtmlBuilder<Message>, options: BadgeOptions, children: Children): Html =>
	h.span(
		[
			h.Class(
				cn(
					badgeVariants({
						className: options.className,
						mono: options.mono ?? false,
						pill: options.pill ?? false,
						size: options.size,
						variant: options.variant,
					}),
				),
			),
			h.DataAttribute("slot", "badge"),
			...(options.style === undefined ? [] : [h.Style(options.style)]),
		],
		children,
	)

/** `<Separator orientation>` (Base UI): a `role="separator"` div with its orientation attributes. */
export const separator = <Message>(
	h: HtmlBuilder<Message>,
	orientation: "horizontal" | "vertical",
	className: string | undefined,
	slot = "separator",
	styles: string = separatorStyles,
): Html =>
	h.div(
		[
			h.AriaOrientation(orientation),
			h.Class(cn(styles, className)),
			h.DataAttribute("orientation", orientation),
			h.DataAttribute("slot", slot),
			h.Role("separator"),
		],
		[],
	)

/**
 * `<Avatar><AvatarFallback>`: Base UI renders the fallback while there is no loaded image. Images
 * (Clerk avatars, org logos) are not rendered yet: they need the Base UI load-status Mount.
 */
export const avatarFallback = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; fallbackClassName?: string }>,
	initials: string,
): Html =>
	h.span(
		[h.Class(cn(avatarStyles, options.className)), h.DataAttribute("slot", "avatar")],
		[
			h.span(
				[
					h.Class(cn(avatarFallbackStyles, options.fallbackClassName)),
					h.DataAttribute("slot", "avatar-fallback"),
				],
				[initials],
			),
		],
	)
