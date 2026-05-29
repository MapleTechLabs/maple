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
	if (import.meta.env.DEV) return true
	if (!isClerkAuthEnabled) return true

	// Guarded by the build-time `isClerkAuthEnabled` constant above: in
	// self-hosted builds there is no ClerkProvider, so calling this hook
	// unconditionally would crash. The branch is statically resolved per build.
	// oxlint-disable-next-line react-doctor/rules-of-hooks
	const { organization, isLoaded } = useOrganization()
	if (!isLoaded) return false

	return organization?.publicMetadata?.session_replays === true
}
