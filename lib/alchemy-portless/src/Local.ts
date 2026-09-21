// The `Portless.Route` provider group served by alchemy's dev sidecar (see its
// `Local/Sidecar.ts`); mirrors alchemy's own `Command/Local.ts`.
//
// A default-exported Layer, not a self-launching module: since alchemy
// 2.0.0-beta.79 one sidecar imports every provider group and launches it, and a
// module that calls `RpcServer.launch` itself is refused with "must
// default-export its provider Layer" before any dev stack is planned.
import type * as RpcServer from "alchemy/Local/RpcServer"
import { RouteProviderLocal } from "./Route.ts"

export default RouteProviderLocal() satisfies RpcServer.ProviderLayer
