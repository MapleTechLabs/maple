/**
 * The api Worker's internal RPC surface, over a service binding: the MCP tool
 * catalog and executor for the alerting Worker, and diagnosis submission. RPC
 * has no HttpApi request to construct the application services for it, so it
 * gets a sibling isolate-wide service graph — the headless one the MCP tools
 * run on. The bridge envelopes a typed failure for the caller's `toRpcAsync`
 * and throws a defect as-is; one Postgres socket per call, released with it.
 */
import type { MapleApiRpcContract } from "@maple/domain/internal-rpc"
import { type Context, Effect, Layer } from "effect"
import type { MapleDbConnection } from "../platform/bindings"
import { layerPg } from "../platform/DatabasePgLive"
import { withPgConnectionScope } from "../platform/pg-connection-scope"
import type { ApiPortsLayer } from "./bindings"
import { forIsolate } from "./http"
import { rpcModule } from "./modules"

/** The headless service graph, built once per isolate on the first RPC call. */
export const buildRpcServices = (isolate: Context.Context<never>, ports: ApiPortsLayer) =>
	Effect.gen(function* () {
		const { InvestigationServicesLive } = yield* Effect.promise(
			() => import("../runtime/mcp-service-graph"),
		)
		return yield* forIsolate(isolate)(
			Layer.build(InvestigationServicesLive.pipe(Layer.provideMerge(layerPg), Layer.provide(ports))),
		)
	})

type RpcServices = Effect.Success<ReturnType<typeof buildRpcServices>>

/** The RPC methods over the cached service graph, as the init returns them beside `fetch`. */
export const makeInternalRpc = (
	rpcServices: Effect.Effect<RpcServices, unknown>,
	ports: Layer.Layer<MapleDbConnection>,
) => {
	const runRpc = <A, E, R>(program: Effect.Effect<A, E, R>) =>
		Effect.flatMap(rpcServices.pipe(Effect.orDie), (services) =>
			withPgConnectionScope(program).pipe(
				Effect.provideContext(services),
				// oxlint-disable-next-line effecttsgo/strict-effect-provide -- the call IS the boundary the ports belong to.
				Effect.provide(ports),
			),
		)
	return {
		listMcpTools: () => Effect.flatMap(rpcModule, ({ listMcpToolsRpc }) => runRpc(listMcpToolsRpc)),
		callMcpTool: (input: unknown) =>
			Effect.flatMap(rpcModule, ({ callMcpToolRpc }) => runRpc(callMcpToolRpc(input))),
		submitDiagnosis: (input: unknown) =>
			Effect.flatMap(rpcModule, ({ submitDiagnosisRpc }) => runRpc(submitDiagnosisRpc(input))),
	} satisfies MapleApiRpcContract
}
