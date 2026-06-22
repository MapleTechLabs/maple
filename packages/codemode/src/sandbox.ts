// Workers-runtime-only Code Mode driver. Pulls in `cloudflare:workers`
// (`RpcTarget`) and the `WorkerLoader` binding, so it lives behind the
// `@maple/codemode/sandbox` subpath — the root barrel stays Node/test-safe.
import { RpcTarget } from "cloudflare:workers"
import { buildHarnessModule } from "./harness.ts"
import type { CodeRunResult, RpcCallResult } from "./types.ts"
import {
	DEFAULT_COMPAT_DATE,
	DEFAULT_CPU_MS,
	DEFAULT_SUBREQUESTS,
	DEFAULT_WALL_MS,
} from "./types.ts"

/** Host-supplied bridge: run one `maple.<name>(input)` call and return its result. */
export type CodeModeDispatch = (name: string, input: unknown) => Promise<RpcCallResult>

/**
 * The RPC target handed to the sandbox isolate as `env.MAPLE`. It must be an
 * `RpcTarget` subclass so Cloudflare passes it across the Worker Loader boundary
 * by reference (a plain object would structured-clone and drop the method). The
 * dispatch closure stays in the parent isolate; the sandbox only gets a stub.
 */
export class MapleSupervisor extends RpcTarget {
	readonly #dispatch: CodeModeDispatch

	constructor(dispatch: CodeModeDispatch) {
		super()
		this.#dispatch = dispatch
	}

	async call(name: string, input: unknown): Promise<RpcCallResult> {
		try {
			return await this.#dispatch(name, input)
		} catch (error) {
			return {
				ok: false,
				error: {
					name: error instanceof Error ? error.name : "Error",
					message: error instanceof Error ? error.message : String(error),
				},
			}
		}
	}
}

export interface RunCodeOptions {
	/** Model-written snippet (plain JS, spliced into the harness IIFE). */
	readonly code: string
	/** Bridge each `maple.<name>(input)` call back to the host's tools. */
	readonly dispatch: CodeModeDispatch
	/** Unique-per-call id → fresh isolate each run (Code Mode semantics). */
	readonly id: string
	readonly capBytes?: number
	readonly compatibilityDate?: string
	readonly cpuMs?: number
	readonly subRequests?: number
	readonly wallMs?: number
}

/**
 * Load the model's snippet into a fresh dynamic worker with network disabled
 * (`globalOutbound: null`) and only the `maple` RPC capability, run it, and
 * return the captured `{ logs, returnValue, error }`. Never throws — a load
 * failure, RPC failure, or wall-clock timeout is reported as a `crashed`
 * result so the caller can surface it to the model as a value.
 */
export const runCodeInSandbox = async (
	loader: WorkerLoader,
	options: RunCodeOptions,
): Promise<CodeRunResult> => {
	const supervisor = new MapleSupervisor(options.dispatch)
	const controller = new AbortController()
	const timer = setTimeout(() => controller.abort(), options.wallMs ?? DEFAULT_WALL_MS)
	try {
		const stub = loader.get(options.id, async () => ({
			compatibilityDate: options.compatibilityDate ?? DEFAULT_COMPAT_DATE,
			mainModule: "main.js",
			modules: { "main.js": buildHarnessModule(options.code, options.capBytes) },
			env: { MAPLE: supervisor },
			globalOutbound: null,
			limits: {
				cpuMs: options.cpuMs ?? DEFAULT_CPU_MS,
				subRequests: options.subRequests ?? DEFAULT_SUBREQUESTS,
			},
		}))
		const response = await stub
			.getEntrypoint()
			.fetch("https://codemode/run", { signal: controller.signal })
		const payload = (await response.json()) as Partial<CodeRunResult> | null
		return {
			logs: payload?.logs ?? [],
			returnValue: payload?.returnValue,
			error: payload?.error ?? null,
		}
	} catch (error) {
		return {
			logs: [],
			returnValue: undefined,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
			crashed: true,
		}
	} finally {
		clearTimeout(timer)
	}
}
