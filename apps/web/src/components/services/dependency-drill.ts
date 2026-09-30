import { quoteWhereValue } from "@maple/domain/where-clause"

export type DependencyDrillKind = "service" | "database" | "messaging" | "rpc" | "http"

/**
 * Where-clause that drills from a dependency edge to the spans behind it.
 *
 * The traces page filters root spans unless `root_only = false`, and a client
 * span is almost never a root, so every drill opens the span-level list. There
 * is no span-kind filter (a `SpanKind = ...` clause becomes a span-attribute
 * filter that matches nothing), and the parser drops `(a OR b)` groups, so each
 * drill is one aliased key that the query engine matches under every spelling.
 *
 * Targets mirror how the edge rollups name them: messaging and rpc fall back to
 * the system when the destination or `rpc.service` is absent, so those drills
 * also require the absence, otherwise they would match every destination of the
 * system. The rpc system uses the legacy key because that is what the rollup
 * reads today.
 *
 * Known gap: when a destination or rpc.service is literally named after its
 * system, the rollup merges those spans and the fallback spans into one edge.
 * Matching both needs an OR the where-clause parser does not support, so the
 * drill shows only the fallback spans.
 */
export function dependencyDrillWhereClause(
	kind: DependencyDrillKind,
	target: string,
	system: string,
): string {
	const value = quoteWhereValue(target)
	const namedBySystem = system !== "" && system === target
	const spans = (...clauses: string[]) => ["root_only = false", ...clauses].join(" AND ")
	switch (kind) {
		case "service":
			return spans(`server.address contains ${value}`)
		case "database":
			return spans(`db.system.name = ${value}`)
		case "messaging":
			return namedBySystem
				? spans(`messaging.system = ${value}`, "messaging.destination.name !exists")
				: spans(`messaging.destination.name = ${value}`)
		case "rpc":
			return namedBySystem
				? spans(`rpc.system = ${value}`, "rpc.service !exists")
				: spans(`rpc.service = ${value}`)
		case "http":
			return spans(`server.address = ${value}`)
	}
}
