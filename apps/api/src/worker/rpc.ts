/**
 * The api Worker's internal RPC surface, over a service binding: the MCP tool
 * catalog and executor for the alerting Worker, and diagnosis submission. RPC
 * has no HttpApi request to construct the application services for it, so it
 * gets a sibling isolate-wide service graph — the headless one the MCP tools
 * run on. The bridge envelopes a typed failure for the caller's `toRpcAsync`
 * and throws a defect as-is; one Postgres socket per call, released with it.
 */
import type { MapleApiRpcContract } from "@maple/domain/internal-rpc"
import { WorkerConfigProviderLayer, workerEnvironmentLayer } from "@maple/infra/worker-runtime"
import { type Context, Effect, Exit, Layer, Scope } from "effect"
import type { ApiPortsLayer } from "./bindings"
import { WorkerPlatformLive } from "./http"
import { pgScopeModule, rpcModule } from "./modules"

/** A layer built for the isolate: its scope is never closed (workerd has no teardown), except when the build itself fails. */
const buildForIsolate = <A, E, R>(layer: Layer.Layer<A, E, R>) =>
	Effect.gen(function* () {
		const scope = yield* Scope.make()
		return yield* Layer.buildWithScope(layer, scope).pipe(
			Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
		)
	})

/** The headless service graph, built once per isolate on the first RPC call. */
export const buildRpcServices = (isolate: Context.Context<never>, ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const [{ InvestigationServicesLive }, { layerPg }] = yield* Effect.all([
			Effect.promise(() => import("../runtime/mcp-service-graph")),
			Effect.promise(() => import("../platform/DatabasePgLive")),
		])
		// Same reason as `buildIsolateHandler`: a service graph built inside the
		// first RPC call's fiber must not carry that call's context.
		return yield* buildForIsolate(
			InvestigationServicesLive.pipe(
				Layer.provideMerge(WorkerPlatformLive),
				Layer.provideMerge(layerPg),
				Layer.provideMerge(workerEnvironmentLayer),
				Layer.provideMerge(WorkerConfigProviderLayer),
				Layer.provide(ports),
			),
		).pipe(Effect.updateContext((_: Context.Context<never>) => isolate))
	})

type RpcServices = Effect.Success<ReturnType<typeof buildRpcServices>>

/** The RPC methods over the cached service graph, as the init returns them beside `fetch`. */
export const makeInternalRpc = (rpcServices: Effect.Effect<RpcServices, unknown>) =>
	Effect.gen(function* () {
		const pgScope = yield* Effect.cached(pgScopeModule)
		const rpc = yield* Effect.cached(rpcModule)
		const runRpc = <A, E, R>(program: Effect.Effect<A, E, R>) =>
			Effect.gen(function* () {
				const [services, { withPgConnectionScope }] = yield* Effect.all([
					rpcServices.pipe(Effect.orDie),
					pgScope,
				])
				return yield* withPgConnectionScope(program).pipe(Effect.provideContext(services))
			})
		return {
			listMcpTools: () => Effect.flatMap(rpc, ({ listMcpToolsRpc }) => runRpc(listMcpToolsRpc)),
			callMcpTool: (input: unknown) =>
				Effect.flatMap(rpc, ({ callMcpToolRpc }) => runRpc(callMcpToolRpc(input))),
			submitDiagnosis: (input: unknown) =>
				Effect.flatMap(rpc, ({ submitDiagnosisRpc }) => runRpc(submitDiagnosisRpc(input))),
		} satisfies MapleApiRpcContract
	})
