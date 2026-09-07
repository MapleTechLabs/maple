/**
 * The investigation fan-out Workflow's contract, as its two callers see it.
 *
 * The api Worker hosts the Workflow as an alchemy class and binds it under
 * the class name; the alerting Worker binds the same physical workflow
 * cross-script under the SAME key, because the services that start
 * investigations (`AlertsService`, `ErrorsService`, …) run in both Workers and
 * read the binding by this one name.
 */
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
