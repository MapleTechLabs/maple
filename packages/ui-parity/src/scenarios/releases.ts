import { checkBox, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** Releases from the seeded rollouts (payment-svc 3.5.0 raised errors), with GitHub commits. */
const release = opsScenarios("releases", "Releases")

export const releasesArea: AreaModule = {
	area: "releases",
	scenarios: [
		release("list", "Last 7 days", "/releases"),
		release("list-errors-up", "Filtered to errors up", "/releases", {
			steps: act(checkBox("errors up")),
		}),
		release("detail", "payment-svc 3.5.0", `/releases/${SEEDED.paymentRelease}`),
		release("list-empty", "Releases (empty org)", "/releases", { dataset: EMPTY }),
	],
}
