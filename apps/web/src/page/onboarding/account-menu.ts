import { initialsFrom } from "@maple/ui/lib/initials"
import { isClerkAuthEnabled } from "../../lib/services/common/auth-mode"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { ClerkUser } from "../../platform/clerk"
import { orgAvatar } from "../../shell/clerk-org-switcher-view"
import { warmAvatarTone } from "@maple/views/ui/avatar-tone"
import { avatarFallback } from "@maple/views/ui/display"
import { icon } from "@maple/views/ui/icon"
import type { MenuEntry } from "@maple/views/ui/menu-view"
import type { Message } from "./index"
import { typography } from "@maple/views/ui/typography"
import { identityLabel } from "@maple/views/ui/identity-label"
import { hstack } from "@maple/views/ui/stack"

// `OnboardingOrgSwitcher` and `OnboardingUserMenu`: the account actions in the onboarding header.

const AVATAR_CLASS = "size-5 rounded-md text-3xs"
export const LOG_OUT = "log-out"

/** `UserAvatar`: initials on the name's warm tile (no image in a stubbed or fresh account). */
const userAvatar = <M>(h: HtmlBuilder<M>, name: string): Html =>
	avatarFallback(
		h,
		{
			className: `bg-muted ${AVATAR_CLASS}`,
			fallbackClassName: `rounded-[inherit] font-medium ${warmAvatarTone(name)}`,
		},
		initialsFrom(name),
	)

const nameOf = (user: Option.Option<ClerkUser>): string =>
	Option.match(user, { onNone: () => "User", onSome: (found) => found.fullName ?? found.email ?? "User" })

/** The org switcher's trigger: the active org's avatar and name. */
export const orgTriggerChildren = (h: HtmlBuilder<Message>, orgName: string): ReadonlyArray<Html> => [
	orgAvatar(h, orgName, "size-5"),
	h.span([h.Class("max-w-[10rem] truncate"), h.Title(orgName)], [orgName]),
	icon(h, "ChevronExpandYIcon", { className: "ml-0.5 text-muted-foreground" }),
]

export const userTriggerChildren = (
	h: HtmlBuilder<Message>,
	user: Option.Option<ClerkUser>,
): ReadonlyArray<Html> => [
	userAvatar(h, isClerkAuthEnabled ? nameOf(user) : "U"),
	h.span([h.Class("sr-only")], ["Account menu"]),
]

/** `ClerkUserMenu`'s label and Log out; self-hosted has Log out only. */
export const userMenuEntries = (
	h: HtmlBuilder<Message>,
	user: Option.Option<ClerkUser>,
): ReadonlyArray<MenuEntry> => {
	const logOut: MenuEntry = {
		_tag: "Group",
		entries: [{ _tag: "Item", value: LOG_OUT, label: "Log out", icon: "LogoutIcon" }],
	}
	if (!isClerkAuthEnabled) return [logOut]
	const name = nameOf(user)
	const email = Option.getOrElse(
		Option.flatMapNullishOr(user, (found) => found.email),
		() => "",
	)
	return [
		{
			_tag: "Group",
			labelContent: [
				hstack(h, { gap: "2", align: "center", className: "py-1 text-left text-sm" }, [
					userAvatar(h, name),
					identityLabel(h, [
						typography(h, { weight: "medium", truncate: true, attributes: [h.Title(name)] }, [
							name,
						]),
						...(email === ""
							? []
							: [
									typography(
										h,
										{
											size: "xs",
											tone: "muted",
											truncate: true,
											attributes: [h.Title(email)],
										},
										[email],
									),
								]),
					]),
				]),
			],
			entries: [],
		},
		{ _tag: "Separator" },
		logOut,
	]
}
