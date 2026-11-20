import { Layer } from "effect"
import type { TenantContext } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { CurrentMcpTenant } from "../../src/mcp/tenant"

/** A tool call's tenant and the actor its services check, as the executor provides them. */
export const mcpTenantLayer = (tenant: TenantContext) =>
	Layer.mergeAll(Layer.succeed(CurrentMcpTenant, tenant), Layer.succeed(Policy.CurrentActor, tenant))
