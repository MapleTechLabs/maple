import type { WorkflowJobAnnotation, WorkflowJobJob, WorkflowRunJob } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { Context, type Effect } from "effect"

/**
 * Where a finished CI workflow run or job goes once the VCS layer has resolved its org. Optional in
 * `VcsSyncService`, like the comment sinks: a root without it drops the event.
 *
 * Returns `Effect<void, never>` so a failure downstream never fails the job and makes GitHub
 * redeliver an event the VCS layer already handled.
 */
export interface WorkflowEventSinkApi {
	readonly onWorkflowRun: (orgId: OrgId, job: WorkflowRunJob) => Effect.Effect<void>
	/** `annotations` are what a failed job reported about itself; empty for a job that passed. */
	readonly onWorkflowJob: (
		orgId: OrgId,
		job: WorkflowJobJob,
		annotations: ReadonlyArray<WorkflowJobAnnotation>,
	) => Effect.Effect<void>
}

export class WorkflowEventSink extends Context.Service<WorkflowEventSink, WorkflowEventSinkApi>()(
	"@maple/api/services/integrations/vcs/WorkflowEventSink",
) {}
