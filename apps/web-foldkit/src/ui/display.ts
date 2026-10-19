import { cn } from "@maple/ui/lib/utils"
import { avatarFallbackStyles, avatarImageStyles, avatarStyles } from "@maple/ui/styles/ui/avatar"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { kbdGroupStyles, kbdStyles } from "@maple/ui/styles/ui/kbd"
import { separatorStyles } from "@maple/ui/styles/ui/separator"
import type { VariantProps } from "class-variance-authority"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"

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

export type BadgeOptions<Message = never> = VariantProps<typeof badgeVariants> &
	Readonly<{ className?: string; attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute> }>

/** `<Badge>`: the same `badgeVariants` call, className folded in by cva. */
export const badge = <Message>(
	h: HtmlBuilder<Message>,
	options: BadgeOptions<Message>,
	children: Children,
): Html =>
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
			...(options.attributes ?? []),
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
 * `<Avatar><AvatarImage><AvatarFallback>`: the initials, with `imageUrl` (a Clerk avatar, an org
 * logo) laid over them. Until it loads, or if it fails (`alt=""` draws nothing), the initials show.
 */
export const avatarFallback = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; fallbackClassName?: string; imageUrl?: string; imageClassName?: string }>,
	initials: string,
): Html => {
	const imageUrl = options.imageUrl ?? ""
	return h.span(
		[h.Class(cn(avatarStyles, imageUrl === "" ? undefined : "relative", options.className)), h.DataAttribute("slot", "avatar")],
		[
			h.span(
				[
					h.Class(cn(avatarFallbackStyles, options.fallbackClassName)),
					h.DataAttribute("slot", "avatar-fallback"),
				],
				[initials],
			),
			...(imageUrl === ""
				? []
				: [
						h.img([
							h.Src(imageUrl),
							h.Alt(""),
							h.Class(cn(avatarImageStyles, "absolute inset-0", options.imageClassName)),
							h.DataAttribute("slot", "avatar-image"),
						]),
					]),
		],
	)
}
