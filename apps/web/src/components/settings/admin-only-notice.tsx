import { useOrganization } from "@clerk/clerk-react"

import { Alert, AlertDescription } from "@maple/ui/components/ui/alert"
import { cn } from "@maple/ui/lib/utils"

import { ShieldIcon } from "@/components/icons"
import { useIsOrgAdmin } from "@/hooks/use-is-org-admin"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

interface MemberName {
	readonly firstName?: string | null
	readonly lastName?: string | null
	readonly identifier?: string | null
}

/** A member's display name: full name, else their sign-in identifier, else nothing. */
export function memberDisplayName(user: MemberName | null | undefined): string | undefined {
	const fullName = [user?.firstName, user?.lastName].filter((part) => part).join(" ")
	return fullName || user?.identifier || undefined
}

/** "Only admins can change X." plus "Ask <name>." when an admin's name is known. */
export function adminOnlyNoticeText(subject: string, adminName: string | undefined): string {
	const lead = `Only admins can change ${subject}.`
	return adminName === undefined ? lead : `${lead} Ask ${adminName}.`
}

/** First admin of the active organization, from one filtered page of memberships. */
function useFirstAdminName(): string | undefined {
	const { memberships } = useOrganization({ memberships: { role: ["org:admin"], pageSize: 1 } })
	return memberDisplayName(memberships?.data?.[0]?.publicUserData)
}

function NoticeWithAdminName({ subject, className }: { subject: string; className?: string }) {
	return <Notice text={adminOnlyNoticeText(subject, useFirstAdminName())} className={className} />
}

function Notice({ text, className }: { text: string; className?: string }) {
	return (
		<Alert size="sm" className={cn("max-w-3xl", className)}>
			<ShieldIcon />
			<AlertDescription>{text}</AlertDescription>
		</Alert>
	)
}

/**
 * The one slim notice at the top of a tab a member can see but not change. Renders nothing for
 * admins. `subject` completes "Only admins can change ...", e.g. "billing" or "AI settings".
 */
export function AdminOnlyNotice({ subject, className }: { subject: string; className?: string }) {
	const isAdmin = useIsOrgAdmin()
	if (isAdmin) return null
	// Self-hosted runs as root (always admin), but never call Clerk hooks without Clerk.
	if (!isClerkAuthEnabled)
		return <Notice text={adminOnlyNoticeText(subject, undefined)} className={className} />
	return <NoticeWithAdminName subject={subject} className={className} />
}
