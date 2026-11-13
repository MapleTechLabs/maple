import { CurrentTenant, isOpenToAnalysts } from "@maple/domain/http"
import { requiredScopeForRoute, V2InsufficientPermissions } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Effect } from "effect"

type Called = Parameters<typeof isOpenToAnalysts>[0]

/**
 * Fails for an analyst on every endpoint that operates the organization. It runs in the auth layers,
 * so an endpoint added later is refused until it, or its whole group, is marked `AnalystAccess`.
 */
export const checkAnalystAccess = (
	roles: ReadonlyArray<string>,
	called: Called,
): Effect.Effect<void, CurrentTenant.LimitedRoleError> =>
	Policy.isAnalyst(roles) && !isOpenToAnalysts(called)
		? Effect.fail(new CurrentTenant.LimitedRoleError({ message: Policy.analystMessage }))
		: Effect.void

/**
 * {@link checkAnalystAccess} for `/v2`, where the scope registry already names the POSTs that
 * only read. `routePath` is the matched route template, as that registry expects.
 */
export const checkAnalystAccessV2 = (
	roles: ReadonlyArray<string>,
	called: Called,
	routePath: string,
): Effect.Effect<void, ReturnType<typeof V2InsufficientPermissions.make>> =>
	Policy.isAnalyst(roles) &&
	!isOpenToAnalysts(called) &&
	requiredScopeForRoute(called.endpoint.method, routePath)?.access !== "read"
		? Effect.fail(V2InsufficientPermissions.make(Policy.analystMessage))
		: Effect.void
