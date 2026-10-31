import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { icon } from "../../../ui/icon"

// `memberDisplayName` and `AdminOnlyNotice`.

interface MemberName {
	readonly firstName?: string | null
	readonly lastName?: string | null
	readonly identifier?: string | null
}

/** A member's display name: full name, else their sign-in identifier, else nothing. */
export const memberDisplayName = (user: MemberName | null | undefined): string | undefined => {
	const fullName = [user?.firstName, user?.lastName].filter((part) => part).join(" ")
	return fullName || user?.identifier || undefined
}

/** The first admin who is not the viewer: the notice never tells someone to ask themselves. */
export const otherAdminName = (
	admins: ReadonlyArray<{ readonly publicUserData?: (MemberName & { readonly userId?: string }) | null }>,
	viewerId: string | null | undefined,
): string | null =>
	memberDisplayName(admins.find((admin) => admin.publicUserData?.userId !== viewerId)?.publicUserData) ??
	null

/** "Only admins can change X." plus "Ask <name>." when an admin's name is known. */
export const adminOnlyNoticeText = (subject: string, adminName: string | null): string => {
	const lead = `Only admins can change ${subject}.`
	return adminName === null ? lead : `${lead} Ask ${adminName}.`
}

/**
 * The slim notice atop a tab a member can see but not change. `isKnownMember`: the session read
 * says so; while it is unknown or failed, nothing claims the viewer is not an admin.
 */
export const adminOnlyNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		isKnownMember: boolean
		subject: string
		adminName: string | null
		className?: string
	}>,
): ReadonlyArray<Html> =>
	!options.isKnownMember
		? []
		: [
				alert(h, { size: "sm", className: options.className }, [
					icon(h, "ShieldIcon"),
					alertDescription(h, [adminOnlyNoticeText(options.subject, options.adminName)]),
				]),
			]
