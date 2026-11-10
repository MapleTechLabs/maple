// Coalescing expressions for OpenTelemetry attribute renames.
//
// Semconv renames keys; instrumentation in the wild does not update in lockstep.
// Anything that reads a renamed key has to accept BOTH spellings, or it silently
// loses the attribute for whichever half of the fleet uses the other one — an
// empty environment column, a service-map node collapsed onto the wrong label.
// Each expression here is used in two places that MUST agree byte-for-byte:
// the materialized view that pre-extracts the value at write time, and the
// query-engine builder that reads it off the raw table.
//
// The key pairs come from the shared rename table in `../semconv`.

import type { Expr } from "@maple-dev/effect-orm/expr"
import * as CH from "@maple-dev/effect-orm/expr"
import { compile } from "@maple-dev/effect-orm/sql"
import { currentThenDeprecated, deprecatedThenCurrent } from "../semconv"

/**
 * The shape every caller shares: a query builder's `$.ResourceAttributes` /
 * `$.SpanAttributes` column accessor, and the bare-column stand-in below that
 * the generated SQL text is compiled from.
 */
interface MapColumnLike {
	get(key: string): Expr<string>
}

const mapColumn = (name: string): MapColumnLike => {
	const column = CH.dynamicColumn<Record<string, string>>(name)
	return { get: (key) => CH.mapGet(column, key) }
}

/** The current key, else the deprecated one. A map lookup is `''` when the key is absent. */
const currentFirst = (
	attributes: MapColumnLike,
	[current, deprecated]: readonly [string, string],
): Expr<string> => CH.coalesce(CH.nullIf(attributes.get(current), ""), attributes.get(deprecated))

/** The deprecated key when set, else the current one. */
const legacyFirst = (
	attributes: MapColumnLike,
	[deprecated, current]: readonly [string, string],
): Expr<string> => {
	const legacy = attributes.get(deprecated)
	return CH.if_(legacy.neq(""), legacy, attributes.get(current))
}

/**
 * Canonical deployment-environment expression, shared by the materialized views
 * that pre-extract `DeploymentEnv` at write time and by the runtime queries that
 * read the environment straight off `ResourceAttributes`.
 *
 * OpenTelemetry renamed the resource attribute: `deployment.environment.name` is
 * the stable key, and the registry marks plain `deployment.environment` as
 * deprecated ("Replaced by `deployment.environment.name`"). Both spellings are in
 * the wild — Maple's own SDKs and the ingest gateway dual-emit, an OTel SDK new
 * enough to have adopted the rename sends only `.name`, and everything older
 * sends only the legacy key. Reading either one alone drops an environment for
 * half the fleet, which is what this expression exists to prevent.
 *
 * Map lookups return `''` for a missing key, so the `nullIf` is what turns
 * "absent" into a `coalesce` fallback. The last argument is non-nullable, so the
 * whole expression stays `String` — it can feed a non-Nullable MV column.
 */
export function deploymentEnvExpr(resourceAttributes: MapColumnLike): Expr<string> {
	return currentFirst(resourceAttributes, currentThenDeprecated("deployment.environment"))
}

/**
 * SQL text required by Tinybird materialization and ClickHouse migration DDL.
 * Compiles byte-identically to {@link deploymentEnvExpr} applied to the raw
 * `ResourceAttributes` column, so an MV's pre-extracted `DeploymentEnv` and the
 * read side's raw-table fallback agree on every row.
 */
export const DEPLOYMENT_ENV_SQL = compile(deploymentEnvExpr(mapColumn("ResourceAttributes")).toFragment())

/**
 * Canonical messaging-destination expression.
 *
 * The messaging semconv namespaced the destination as `messaging.destination.name`
 * and deprecated the bare `messaging.destination`. The service-map external-edge
 * rollup keys its `TargetName` off this: reading only the deprecated spelling
 * made every topic and queue from current instrumentation fall back to the
 * *system* value, collapsing per-destination edges into a single `kafka` / `sqs`
 * node. Maple's own producer spans (`VcsSyncQueue`) emit the `.name` key, so the
 * gap was visible on our own service map.
 */
export function messagingDestinationExpr(spanAttributes: MapColumnLike): Expr<string> {
	return currentFirst(spanAttributes, currentThenDeprecated("messaging.destination"))
}

/** SQL text for {@link messagingDestinationExpr} over the raw `SpanAttributes` column. */
export const MESSAGING_DESTINATION_SQL = compile(
	messagingDestinationExpr(mapColumn("SpanAttributes")).toFragment(),
)

/**
 * Canonical container-runtime expression.
 *
 * Semconv v1.37.0 renamed `container.runtime` to `container.runtime.name`. Both
 * spellings are in the wild and will be for a long time: the OTel Collector's
 * docker/k8s receivers and every SDK older than that release still send the bare
 * key, while current ones send `.name`. Reading either alone leaves the runtime
 * blank for half the fleet — which shows up as a container detail page with an
 * empty Runtime row, and as a missing Container correlation group.
 *
 * Unlike the two expressions above, no materialized view pre-extracts this, so
 * there is no SQL twin to keep byte-identical; the read paths are the only
 * consumers.
 */
export function containerRuntimeExpr(resourceAttributes: MapColumnLike): Expr<string> {
	return currentFirst(resourceAttributes, currentThenDeprecated("container.runtime"))
}

/**
 * HTTP request method expression for read paths that group by it.
 *
 * Stable HTTP semconv renamed `http.method` to `http.request.method`; a group-by
 * on the legacy key alone put every span from current instrumentation into the
 * `""` bucket. The precedence is legacy-first on purpose: it must match
 * `trace_list_mv`'s pre-extracted `HttpMethod` and the query engine's span filter
 * aliases, so a group, its facet count and the filter it drills into agree on a
 * span that carries both keys with different values.
 */
export function httpRequestMethodExpr(spanAttributes: MapColumnLike): Expr<string> {
	return legacyFirst(spanAttributes, deprecatedThenCurrent("http.method"))
}

/**
 * HTTP response status code expression, legacy-first for the same reason as
 * {@link httpRequestMethodExpr}: it has to agree with `trace_list_mv`'s
 * pre-extracted `HttpStatusCode`.
 */
export function httpResponseStatusCodeExpr(spanAttributes: MapColumnLike): Expr<string> {
	return legacyFirst(spanAttributes, deprecatedThenCurrent("http.status_code"))
}
