/**
 * `CodemodeRuntimeDO` — the Durable Object that hosts a Maple org's Code Mode
 * runtime ([@cloudflare/codemode] `createCodemodeRuntime`). One instance per
 * organization (addressed by org id); it owns the durable execution log +
 * approval state.
 *
 * **Thin shell.** Cloudflare requires DO classes to be exported from the worker
 * entry, but the worker keeps module-scope evaluation light (startup-CPU budget),
 * so the heavy imports (`@cloudflare/codemode`, the connector → the 50-tool
 * registry) live in `./runtime-impl` and are dynamic-imported inside `run()` —
 * the same discipline as the Workflow shells in `worker.ts`. Everything imported
 * here is either `cloudflare:workers` or type-only (erased).
 */
import { DurableObject } from "cloudflare:workers"
import type { ProxyToolOutput } from "@cloudflare/codemode"
import type { CodemodeRuntimeEnv } from "./dispatch"

export class CodemodeRuntimeDO extends DurableObject<CodemodeRuntimeEnv> {
	/**
	 * Run a Code Mode snippet for `orgId`. Returns the runtime's proxy-tool output:
	 * `completed` with the result, `paused` with pending approvals, or `error`.
	 */
	async run(orgId: string, code: string): Promise<ProxyToolOutput> {
		const { runCodemodeSnippet } = await import("./runtime-impl")
		return runCodemodeSnippet(this.ctx, this.env, orgId, code)
	}
}
