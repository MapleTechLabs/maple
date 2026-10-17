import { EMPTY, opsScenarios } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** The error issues list (`/errors/issues`); the hub and one issue live in the routes area. */
const errors = opsScenarios("errors", "Errors")

export const errorsArea: AreaModule = {
	area: "errors",
	scenarios: [
		errors("issues", "Issues list", "/errors/issues"),
		errors("issues-empty", "Issues list (empty org)", "/errors/issues", { dataset: EMPTY }),
	],
}
