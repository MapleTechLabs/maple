import type * as Policy from "@maple/domain/policy"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "@maple/views/ui/alert"
import { icon } from "@maple/views/ui/icon"
import { Array as Arr, Option, Predicate } from "effect"
import { denialReason } from "../../kit/session-grants"

interface MemberName {
	readonly firstName?: string | null
	readonly lastName?: string | null
	readonly identifier?: string | null
}

/** A member's display name: full name, else their sign-in identifier, else nothing. */
export const memberDisplayName = (user: MemberName | null | undefined): string | undefined => {
	const fullName = Arr.join(
		Arr.filter(
			[user?.firstName, user?.lastName],
			(part): part is string => Predicate.isNotNullish(part) && part !== "",
		),
		" ",
	)
	return fullName || user?.identifier || undefined
}

/** The first admin who is not the viewer: the notice never tells someone to ask themselves. */
export const otherAdminName = (
	admins: ReadonlyArray<{ readonly publicUserData?: (MemberName & { readonly userId?: string }) | null }>,
	viewerId: string | null | undefined,
): string | null =>
	memberDisplayName(
		Option.getOrUndefined(Arr.findFirst(admins, (admin) => admin.publicUserData?.userId !== viewerId))
			?.publicUserData,
	) ?? null

/** The denial for `permission`, plus "Ask <name>." when an admin's name is known. */
const adminOnlyNoticeText = (permission: Policy.Permission, adminName: string | null): string => {
	const lead = denialReason(permission)
	return adminName === null ? lead : `${lead} Ask ${adminName}.`
}

/**
 * The slim notice atop a tab a viewer can see but not change, naming the `permission` the change
 * needs. `isKnownMember`: the session read says so; while it is unknown or failed, nothing claims
 * the viewer lacks it.
 */
export const adminOnlyNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		isKnownMember: boolean
		permission: Policy.Permission
		adminName: string | null
		className?: string
	}>,
): ReadonlyArray<Html> =>
	!options.isKnownMember
		? []
		: [
				alert(h, { size: "sm", className: options.className }, [
					icon(h, "ShieldIcon"),
					alertDescription(h, [adminOnlyNoticeText(options.permission, options.adminName)]),
				]),
			]
