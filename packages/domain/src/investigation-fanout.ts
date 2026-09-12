/**
 * The investigation fan-out Workflow's contract, as its two callers see it.
 *
 * The api Worker hosts the Workflow as an alchemy class and binds it under
 * the class name; the alerting Worker binds the same physical workflow
 * cross-script under the SAME key, because the services that start
 * investigations (`AlertsService`, `ErrorsService`, …) run in both Workers and
 * read the binding by this one name.
 */
import type { IssueSeverity } from "./http/errors"

export const INVESTIGATION_FANOUT_BINDING = "InvestigationFanoutWorkflow"

export interface InvestigationFanoutWorkflowPayload {
	readonly orgId: string
	readonly investigationId: string
	/**
	 * Ceiling on hypotheses, from severity and incident kind at enqueue time. The
	 * planner may return fewer; it may not return more.
	 */
	readonly maxWidth: number
	/** Restart counter, so a retry gets a distinct workflow instance id. */
	readonly attempt: number
	/**
	 * Passes the caller reserved against the daily budget before the planner ran.
	 * `plan` reconciles the difference downward once the real width is known.
	 */
	readonly reservedPasses: number
}

export interface InvestigationFanoutWorkflowResult {
	readonly status: "ranked" | "inconclusive" | "skipped" | "failed"
}

/**
 * How many hypotheses a subject of this shape deserves.
 *
 * This is the surviving half of the old `fanoutSize` table. The half that is
 * gone decided *whether* to fan out at all — that question no longer exists, and
 * conflating the two is what let a medium-severity alert compute a width of five
 * and dispatch zero.
 *
 * An anomaly is capped below the others because an anomaly is already a narrow
 * claim about one signal; five angles on it mostly produces four polite
 * negatives. A null severity reads as medium rather than as "minimum": an
 * unclassified incident is unclassified, not unimportant, and treating it as the
 * floor is how error incidents — which carry no severity until someone triages
 * them — would get the thinnest investigations.
 *
 * It sits beside the payload rather than beside the planner because the callers
 * that compute a width are the ones that *start* an investigation, and they do
 * not otherwise know anything about how the workflow plans.
 */
export const widthFor = (
	severity: IssueSeverity | null | undefined,
	incidentKind: string | undefined,
): number => {
	if (incidentKind === "anomaly") return 3
	switch (severity) {
		case "critical":
			return 5
		case "high":
			return 4
		case "low":
			return 3
		default:
			return 4
	}
}
