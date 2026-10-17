import { clickTab, EMPTY, opsScenarios, SEEDED, act } from "./ops-kit.ts"
import type { AreaModule } from "./types.ts"

/** AI investigations: one running, one diagnosed (payment-svc pool exhaustion), one resolved. */
const investigation = opsScenarios("investigations", "Investigations")
const diagnosed = `/investigations/${SEEDED.diagnosedInvestigation}`

export const investigationsArea: AreaModule = {
	area: "investigations",
	scenarios: [
		investigation("list", "Active investigations", "/investigations"),
		investigation("list-history", "History tab", "/investigations", { steps: act(clickTab(/^History/)) }),
		investigation("diagnosed", "Diagnosed: payment-svc latency", diagnosed),
		investigation("diagnosed-evidence", "Diagnosed, evidence tab", diagnosed, {
			steps: act(clickTab(/^Evidence/)),
		}),
		// The in-progress graph re-lays out as live progress lands (a 1px drift run to run), so it is masked.
		investigation("running", "Still investigating", `/investigations/${SEEDED.runningInvestigation}`, {
			mask: (page) => [page.getByRole("application", { name: "Investigation provenance graph" })],
		}),
		investigation("list-empty", "Investigations (empty org)", "/investigations", { dataset: EMPTY }),
	],
}
