import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "@maple/views/ui/avatar-tone"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { type UserRow, type UserSignal, userLabel } from "./data"

// Pieces the users list and detail share: the avatar, the name block and the signal tags.

const AVATAR_SIZE = { sm: "size-7 text-2xs", lg: "size-11 text-sm" } as const

/** A user's initials tile, the same warm tone on every page; no name or email draws the user glyph. */
export const userAvatar = <M>(
	h: HtmlBuilder<M>,
	user: Pick<UserRow, "name" | "email" | "userId">,
	size: keyof typeof AVATAR_SIZE = "sm",
): Html => {
	const named = user.name ?? user.email
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"inline-flex shrink-0 items-center justify-center rounded-full font-medium select-none",
					AVATAR_SIZE[size],
					warmAvatarTone(user.userId),
				),
			),
		],
		[named === null ? icon(h, "UserIcon", { className: "size-[60%]" }) : initialsFrom(named)],
	)
}

/** The name over its detail: the email, else the id, plus the group when there is one. */
export const userNameBlock = <M>(h: HtmlBuilder<M>, user: UserRow): Html => {
	const label = userLabel(user)
	const detail = Arr.filter(
		[label === user.email ? user.userId : (user.email ?? user.userId), user.groupId],
		(part): part is string => part !== null && part !== label,
	)
	return vstack(h, { gap: "0", shrink: true, className: "min-w-0" }, [
		typography(h, { size: "xs", tone: "foreground", truncate: true }, [label]),
		typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true }, [Arr.join(detail, " · ")]),
	])
}

const SIGNAL_LABEL = {
	replay: "Replay",
	traces: "Traces",
	logs: "Logs",
	events: "Events",
	mcp: "MCP",
} satisfies { readonly [K in UserSignal]: string }

/** Which signals carry this user, as quiet tags. */
export const signalTags = <M>(h: HtmlBuilder<M>, signals: ReadonlyArray<UserSignal>): ReadonlyArray<Html> =>
	Arr.map(signals, (signal) => badge(h, { variant: "tag" }, [SIGNAL_LABEL[signal]]))
