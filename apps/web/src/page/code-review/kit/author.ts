import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { avatarFallback } from "../../../ui/display"

/** A GitHub login's avatar, from GitHub's public `<login>.png` redirect; the initial while it loads. */
export const authorAvatar = <M>(h: HtmlBuilder<M>, login: string, className?: string): Html =>
	avatarFallback(
		h,
		{
			className: cn("size-[18px] text-4xs", className),
			imageUrl: `https://github.com/${encodeURIComponent(login)}.png?size=64`,
		},
		login.slice(0, 1).toUpperCase(),
	)

/** Avatar and login on one line, the way an author is shown everywhere in Code Review. */
export const authorLabel = <M>(h: HtmlBuilder<M>, login: string, className?: string): Html =>
	h.span(
		[h.Class(cn("inline-flex min-w-0 items-center gap-1.5", className))],
		[authorAvatar(h, login), h.span([h.Class("truncate"), h.Title(login)], [login])],
	)
