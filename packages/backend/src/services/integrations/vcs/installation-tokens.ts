import { Context } from "effect"
import type { ExpiringStore } from "@maple/backend/platform/expiring-store"

export interface InstallationToken {
	readonly token: string
	readonly expiresAtMs: number
	/** When it was minted, so a stale permissions snapshot can be re-checked. */
	readonly mintedAtMs: number
	/** What the installation has accepted; absent when the mint response did not list it. */
	readonly permissions: Readonly<Record<string, string>> | undefined
}

/**
 * VCS installation tokens shared by every provider client built under it, keyed by installation
 * id. Unset, each client keeps its own. Kept apart from the clients so a Worker's init can import it.
 */
export class SharedInstallationTokens extends Context.Reference<ExpiringStore<InstallationToken> | undefined>(
	"@maple/backend/services/integrations/vcs/SharedInstallationTokens",
	{ defaultValue: () => undefined },
) {}
