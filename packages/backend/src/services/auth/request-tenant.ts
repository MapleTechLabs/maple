import { CachePartition } from "@maple/cache"
import { CurrentTenant } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Context, Effect } from "effect"
import { CurrentDataScope } from "@maple/backend/services/warehouse/data-scope"

/**
 * Hands a request's handler its tenant, and for a namespace-limited caller the data scope its
 * warehouse reads run under and a cache partition of its own. Every auth layer provides the tenant
 * through here, so the three cannot come apart.
 */
export const provideRequestTenant =
	(tenant: CurrentTenant.TenantSchema) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, Exclude<R, CurrentTenant.Context>> => {
		const scope = Policy.dataScopeOf(tenant)
		const context = Context.make(CurrentTenant.Context, tenant)
		return Effect.provide(
			effect,
			scope._tag === "All"
				? context
				: context.pipe(
						Context.add(CurrentDataScope, scope),
						Context.add(CachePartition, `data-scope:${Policy.dataScopeKey(scope)}`),
					),
		)
	}
