import { quoteWhereValue } from "@maple/domain/where-clause"

/**
 * Where-clause that drills from an external dependency edge to its spans.
 *
 * Mirrors how `service_external_edges_hourly_mv` names `TargetName`: messaging
 * and rpc fall back to the system when the destination or service is absent,
 * http falls back from `server.address` to `http.host` to `url.authority`. The
 * where-clause parser drops `(a OR b)` groups, so each drill is one key; the
 * query engine's span aliases match every spelling that key stands for.
 */
export function dependencyDrillWhereClause(
	kind: "messaging" | "rpc" | "http",
	target: string,
	system: string,
): string {
	const value = quoteWhereValue(target)
	const namedBySystem = system !== "" && system === target
	switch (kind) {
		case "messaging":
			return `SpanKind = 'Producer' AND ${namedBySystem ? "messaging.system" : "messaging.destination.name"} = ${value}`
		case "rpc":
			return `SpanKind = 'Client' AND ${namedBySystem ? "rpc.system.name" : "rpc.service"} = ${value}`
		case "http":
			return `SpanKind = 'Client' AND server.address = ${value}`
	}
}
