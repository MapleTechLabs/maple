import type { WorkflowJobJob, WorkflowRunJob } from "@maple/domain/http"
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
	readonly onWorkflowJob: (orgId: OrgId, job: WorkflowJobJob) => Effect.Effect<void>
}

export class WorkflowEventSink extends Context.Service<WorkflowEventSink, WorkflowEventSinkApi>()(
	"@maple/api/services/integrations/vcs/WorkflowEventSink",
) {}
