import { initialsFrom } from "@maple/ui/lib/initials"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { warmAvatarTone } from "@maple/views/ui/avatar-tone"
import { badge } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { groupLabel, type UserRow, type UserSignal, userLabel } from "./data"

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

/**
 * The name over its detail: the email, else the id, then the group where the directory's Group
 * column is hidden (a panel under 880px), so a narrow row still says which group it is.
 */
export const userNameBlock = <M>(h: HtmlBuilder<M>, user: UserRow): Html => {
	const label = userLabel(user)
	const detail = Arr.filter(
		[label === user.email ? user.userId : (user.email ?? user.userId)],
		(part): part is string => part !== null && part !== label,
	)
	const group = groupLabel(user)
	return vstack(h, { gap: "0", shrink: true, className: "min-w-0" }, [
		typography(h, { size: "xs", tone: "foreground", truncate: true }, [label]),
		hstack(h, { gap: "1", as: "span", className: "min-w-0" }, [
			typography(h, { size: "2xs", tone: "muted", mono: true, truncate: true, as: "span" }, [
				Arr.join(detail, " · "),
			]),
			// Its own slot, so a long email cannot truncate the group away.
			...(group === null
				? []
				: [
						typography(
							h,
							{
								size: "2xs",
								tone: "muted",
								mono: true,
								truncate: true,
								as: "span",
								className: "max-w-1/2 shrink-0 @min-[880px]/panel:hidden",
							},
							[detail.length === 0 ? group : `· ${group}`],
						),
					]),
		]),
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

/** How many signal tags a directory row shows before folding the rest into `+N`. */
export const SIGNALS_SHOWN = 2

/** The tags a fixed-width lane shows, and the labels folded into its `+N`. */
export const signalLane = (
	signals: ReadonlyArray<UserSignal>,
): Readonly<{ shown: ReadonlyArray<UserSignal>; hidden: ReadonlyArray<string> }> => ({
	shown: signals.slice(0, SIGNALS_SHOWN),
	hidden: Arr.map(signals.slice(SIGNALS_SHOWN), (signal) => SIGNAL_LABEL[signal]),
})
