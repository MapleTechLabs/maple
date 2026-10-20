import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { avatarFallback } from "../../../ui/display"

// `AuthorAvatar` and `AuthorLabel`.
// TODO(avatar-image): the GitHub `<login>.png` image is not loaded yet; Base UI shows the initial
// until it loads, which is what every capture sees (other origins are blocked).

export const authorAvatar = <M>(h: HtmlBuilder<M>, login: string, className?: string): Html =>
	avatarFallback(h, { className: cn("size-[18px] text-4xs", className) }, login.slice(0, 1).toUpperCase())

/** Avatar and login on one line, the way an author is shown everywhere in Code Review. */
export const authorLabel = <M>(h: HtmlBuilder<M>, login: string, className?: string): Html =>
	h.span(
		[h.Class(cn("inline-flex min-w-0 items-center gap-1.5", className))],
		[authorAvatar(h, login), h.span([h.Class("truncate"), h.Title(login)], [login])],
	)
