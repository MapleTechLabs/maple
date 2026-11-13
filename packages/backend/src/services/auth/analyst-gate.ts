import { CurrentTenant, isOpenToAnalysts } from "@maple/domain/http"
import { requiredScopeForRoute, V2InsufficientPermissions } from "@maple/domain/http/v2"
import * as Policy from "@maple/domain/policy"
import { Effect } from "effect"

type Called = Parameters<typeof isOpenToAnalysts>[0]

/**
 * Refuses a read-only role every endpoint that changes the organization. It runs in the auth
 * layers, so an endpoint added later is refused until it, or its whole group, is marked
 * `AnalystAccess`.
 */
export const refuseAnalystWrites = (
	roles: ReadonlyArray<string>,
	called: Called,
): Effect.Effect<void, CurrentTenant.ReadOnlyRoleError> =>
	Policy.isReadOnly(roles) && !isOpenToAnalysts(called)
		? Effect.fail(new CurrentTenant.ReadOnlyRoleError({ message: Policy.readOnlyMessage }))
		: Effect.void

/**
 * {@link refuseAnalystWrites} for `/v2`, where the scope registry already names the POSTs that
 * only read. `routePath` is the matched route template, as that registry expects.
 */
export const refuseAnalystWritesV2 = (
	roles: ReadonlyArray<string>,
	called: Called,
	routePath: string,
): Effect.Effect<void, ReturnType<typeof V2InsufficientPermissions.make>> =>
	Policy.isReadOnly(roles) &&
	!isOpenToAnalysts(called) &&
	requiredScopeForRoute(called.endpoint.method, routePath)?.access !== "read"
		? Effect.fail(V2InsufficientPermissions.make(Policy.readOnlyMessage))
		: Effect.void
