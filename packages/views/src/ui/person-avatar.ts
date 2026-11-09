import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "./avatar-tone"
import { avatarFallback } from "./display"
import { hstack, vstack } from "./stack"
import { typography } from "./typography"

// `PersonAvatar` and `PersonLabel`: a member of the org as a warm initials tile (or their own
// image), alone or beside their name.

const SIZE = { xs: "size-5", sm: "size-6" } as const

/** A member's avatar: their uploaded image, else the warm initials tile seeded by their name. */
export const personAvatar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ name: string; imageUrl?: string; size?: keyof typeof SIZE; className?: string }>,
): Html =>
	avatarFallback(
		h,
		{
			className: cn(SIZE[options.size ?? "sm"], "shrink-0", options.className),
			fallbackClassName: `font-medium ${warmAvatarTone(options.name)}`,
			imageUrl: options.imageUrl ?? "",
		},
		initialsFrom(options.name),
	)

/** Avatar, name and an optional muted line under it ("until Mon 09:00"), truncating in a row. */
export const personLabel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ name: string; imageUrl?: string; detail?: string; size?: keyof typeof SIZE }>,
): Html =>
	hstack(h, { gap: "2", shrink: true }, [
		personAvatar(h, { name: options.name, imageUrl: options.imageUrl, size: options.size }),
		options.detail === undefined
			? typography(h, { size: "sm", truncate: true }, [options.name])
			: vstack(h, { gap: "0", shrink: true }, [
					typography(h, { size: "sm", truncate: true }, [options.name]),
					typography(h, { size: "xs", tone: "muted", truncate: true, numeric: true }, [
						options.detail,
					]),
				]),
	])
