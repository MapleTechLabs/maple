/**
 * The security-audit Workflow, in alchemy's form: yielded from the ai Worker's init, which binds,
 * registers and exports it. One instance per run (instance id = run id), so starting a run twice is
 * a no-op. This file stays light; the run itself is `./workflow.host.ts`, imported on first use.
 */
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { MapleDb } from "@maple/infra/cloudflare"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect } from "effect"

export default class SecurityAuditWorkflow extends Cloudflare.Workflow<SecurityAuditWorkflow>()(
	"SecurityAuditWorkflow",
	// One step per agent invocation: a deep baseline of a large repository runs thousands.
	{ limits: { steps: 25_000 } },
	Effect.gen(function* () {
		// The application database, bound to the host Worker under `MAPLE_DB`.
		yield* MapleDb("ai")
		return Effect.fn("SecurityAuditWorkflow.run")(function* (payload: SecurityAuditWorkflowPayload) {
			const env = yield* Cloudflare.WorkerEnvironment
			const { runHostedAudit } = yield* Effect.promise(() => import("./workflow.host"))
			return yield* runHostedAudit(payload, env)
		})
	}),
) {}
