import type { TenantContext } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"

// Who is behind a query on a connected data source. Kept apart from the service so a surface can
// decide whether to offer the query without loading the drivers and the database layer.

/**
 * Who asks for a query to run. A person or a key answers with its permissions. One of Maple's own
 * unattended runs has no person behind it: the source's `agentAccess` is what admits it.
 */
export type QueryCaller =
	| { readonly kind: "principal"; readonly permissions: Policy.Grants }
	| { readonly kind: "unattended" }

/**
 * The caller behind a tenant. An unattended turn answers for whoever caused it: only one of Maple's
 * own producers is unattended, and a turn with no recorded starter is a person holding nothing.
 */
export const queryCallerOf = (
	tenant: Pick<TenantContext, "permissions" | "turnOrigin" | "turnStarter">,
): QueryCaller => {
	if (tenant.turnOrigin?.kind !== "autonomous")
		return { kind: "principal", permissions: tenant.permissions }
	const starter = tenant.turnStarter
	if (starter?.kind === "producer") return { kind: "unattended" }
	if (starter === undefined) return { kind: "principal", permissions: [] }
	return { kind: "principal", permissions: starter.permissions ?? Policy.grantsOf(starter.roles) }
}

/** Whether `query` would admit this caller, for a surface deciding whether to offer it at all. */
export const mayQueryDataSources = (caller: QueryCaller): boolean =>
	caller.kind === "unattended" || Policy.can(caller.permissions, "data_sources:query")
