import { useOrganization } from "@clerk/clerk-react"
import { isClerkAuthEnabled } from "@/lib/services/common/auth-mode"

/**
 * Gates the Session Replays feature.
 *
 * Always enabled in dev/local, or when Clerk auth is disabled (self-hosted).
 * In production with Clerk, requires `session_replays: true` in the org's
 * publicMetadata.
 */
export function useSessionReplaysEnabled(): boolean {
	const { organization, isLoaded } = useOrganization()

	if (import.meta.env.DEV) return true
	if (!isClerkAuthEnabled) return true
	if (!isLoaded) return false

	return organization?.publicMetadata?.session_replays === true
}
