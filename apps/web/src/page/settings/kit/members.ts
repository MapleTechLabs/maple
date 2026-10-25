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

/** "Only admins can change X." plus "Ask <name>." when an admin's name is known. */
export const adminOnlyNoticeText = (subject: string, adminName: string | null): string => {
	const lead = `Only admins can change ${subject}.`
	return adminName === null ? lead : `${lead} Ask ${adminName}.`
}

/** The slim notice atop a tab a member can see but not change; nothing for admins. */
export const adminOnlyNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isAdmin: boolean; subject: string; adminName: string | null; className?: string }>,
): ReadonlyArray<Html> =>
	options.isAdmin
		? []
		: [
				alert(h, { size: "sm", className: options.className }, [
					icon(h, "ShieldIcon"),
					alertDescription(h, [adminOnlyNoticeText(options.subject, options.adminName)]),
				]),
			]
