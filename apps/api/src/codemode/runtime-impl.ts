/**
 * Heavy Code Mode logic, dynamic-imported by the {@link CodemodeRuntimeDO} shell
 * (keeps `@cloudflare/codemode` + the 50-tool registry out of the worker's
 * startup module graph).
 *
 * Builds a per-org runtime: a {@link MapleConnector} (read tools execute, mutating
 * tools pause for approval) wired to a `DynamicWorkerExecutor` that runs the
 * model's snippet in a Worker-Loader isolate, and dispatches each `maple.<tool>()`
 * call back to the api worker over the `Self` binding.
 */
import {
	createCodemodeRuntime,
	DynamicWorkerExecutor,
	type CodemodeRuntimeHandle,
	type ProxyToolOutput,
} from "@cloudflare/codemode"
import { MapleConnector } from "./connector"
import { makeSelfToolDispatch, type CodemodeRuntimeEnv } from "./dispatch"

/** Build a runtime handle for one org: a per-org connector + a Worker-Loader executor. */
const handleFor = (
	ctx: DurableObjectState,
	env: CodemodeRuntimeEnv,
	orgId: string,
	loader: WorkerLoader,
): CodemodeRuntimeHandle => {
	const dispatch = makeSelfToolDispatch(env, orgId)
	const connector = new MapleConnector(ctx, env, dispatch)
	return createCodemodeRuntime({
		ctx,
		connectors: [connector],
		executor: new DynamicWorkerExecutor({ loader }),
	})
}

/**
 * Run a Code Mode snippet for `orgId`. Degrades to an error result when the
 * LOADER binding is absent (e.g. a deployment without Dynamic Workers), so callers
 * can fall back to direct tools rather than crash.
 */
export const runCodemodeSnippet = (
	ctx: DurableObjectState,
	env: CodemodeRuntimeEnv,
	orgId: string,
	code: string,
): Promise<ProxyToolOutput> => {
	const loader = env.LOADER
	if (!loader) {
		return Promise.resolve({
			status: "error",
			executionId: "",
			error:
				"Code mode is unavailable: the Worker Loader (LOADER) binding is not configured on this deployment.",
		})
	}
	// The proxy tool's signature carries an `options` arg (the AI-SDK tool-call
	// context); the runtime doesn't use it for a direct invocation.
	return handleFor(ctx, env, orgId, loader).tool().execute({ code }, {})
}
