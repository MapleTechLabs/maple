import type { WorkflowState } from "@maple/domain/http"
import { Badge } from "@maple/ui/components/ui/badge"
import { TONE_SOFT } from "@maple/ui/lib/tone"

import { WORKFLOW_LABEL } from "@/components/icons/workflow-ring"

/** Work under way (in progress, in review, verifying, an open PR): the severity-debug blue. */
export const IN_FLIGHT_SOFT = "bg-severity-debug/12 text-severity-debug"
export const IN_FLIGHT_FILL = "bg-severity-debug"

/**
 * Tone only — the wording comes from {@link WORKFLOW_LABEL}, which the state
 * picker, the bulk bar and the workflow ring already share. This file used to
 * carry a fourth copy of the labels, and it was the one that drifted: it said
 * "Wontfix" where every other surface said "Won't fix".
 */
const WORKFLOW_TONE: Record<WorkflowState, string> = {
	triage: TONE_SOFT.warn,
	// Red, not amber: a regression is a fix that did not hold, and it should read
	// as more urgent than an untriaged issue rather than the same.
	regressed: TONE_SOFT.crit,
	todo: TONE_SOFT.neutral,
	// In-flight stages share one "under way" hue, distinct from `done` (it is over)
	// and from the warn/crit stages that need someone to act.
	in_progress: IN_FLIGHT_SOFT,
	in_review: IN_FLIGHT_SOFT,
	verifying: IN_FLIGHT_SOFT,
	done: TONE_SOFT.ok,
	cancelled: TONE_SOFT.neutral,
	wontfix: TONE_SOFT.neutral,
} satisfies Record<WorkflowState, string>

export function WorkflowBadge({ state }: { state: WorkflowState }) {
	return (
		<Badge variant="outline" className={WORKFLOW_TONE[state]}>
			{WORKFLOW_LABEL[state]}
		</Badge>
	)
}
