import { opsScenarios, SEEDED } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** A public link to the platform overview board, and a token that resolves to nothing. */
const share = opsScenarios("share", "Share")

export const shareArea: AreaModule = {
	area: "share",
	scenarios: [
		share("dashboard", "Shared platform overview", `/share/${SEEDED.platformShareToken}`),
		share("not-found", "Unknown share link", "/share/parity_share_unknown"),
	],
}
