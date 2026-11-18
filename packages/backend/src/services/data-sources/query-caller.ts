import type { TenantContext } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"

// Who is behind a query on a connected data source. Kept apart from the service so a surface can
// decide whether to offer the query without loading the drivers and the database layer.

/**
 * Who asks for a query to run. A person or a key answers with its roles. One of Maple's own
 * unattended runs has no person behind it: the source's `agentAccess` is what admits it.
 */
export type QueryCaller =
	| { readonly kind: "principal"; readonly roles: ReadonlyArray<string> }
	| { readonly kind: "unattended" }

/**
 * The caller behind a tenant. An unattended turn answers for whoever caused it: only one of Maple's
 * own producers is unattended, and a turn with no recorded starter is a person holding no role.
 */
export const queryCallerOf = (
	tenant: Pick<TenantContext, "roles" | "turnOrigin" | "turnStarter">,
): QueryCaller => {
	if (tenant.turnOrigin?.kind !== "autonomous") return { kind: "principal", roles: tenant.roles }
	const starter = tenant.turnStarter
	return starter?.kind === "producer"
		? { kind: "unattended" }
		: { kind: "principal", roles: starter?.roles ?? [] }
}

/** Whether `query` would admit this caller, for a surface deciding whether to offer it at all. */
export const mayQueryDataSources = (caller: QueryCaller): boolean =>
	caller.kind === "unattended" || Policy.can(caller.roles, "data_sources:query")
