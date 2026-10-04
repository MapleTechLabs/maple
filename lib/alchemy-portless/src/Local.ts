// The `Portless.Route` provider group for alchemy's dev sidecar. Must default-export the
// Layer; the sidecar refuses modules that call `RpcServer.launch` themselves.
import type * as RpcServer from "alchemy/Local/RpcServer"
import { RouteProviderLocal } from "./Route.ts"

export default RouteProviderLocal() satisfies RpcServer.ProviderLayer
