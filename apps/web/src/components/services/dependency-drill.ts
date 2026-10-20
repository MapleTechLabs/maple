import { quoteWhereValue } from "@maple/domain/where-clause"

export type DependencyDrillKind = "service" | "database" | "messaging" | "rpc" | "http"

/**
 * Where-clause that drills from a dependency edge to the spans behind it.
 *
 * The traces page filters root spans unless `root_only = false`, and a client
 * span is almost never a root, so every drill opens the span-level list. There
 * is no span-kind filter (a `SpanKind = ...` clause becomes a span-attribute
 * filter that matches nothing). Target keys are aliased, so the query engine
 * matches them under every semconv spelling.
 *
 * Targets mirror how the edge rollups name them: messaging and rpc fall back to
 * the system when the destination or `rpc.service` is absent. An edge named
 * after its system therefore holds the fallback spans, plus any spans whose
 * destination or service is literally that name, so the drill matches both and
 * nothing else of the system. The rpc system uses the legacy key because that
 * is what the rollup reads today.
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
				? spans(
						`messaging.system = ${value}`,
						`(messaging.destination.name = ${value} OR messaging.destination.name !exists)`,
					)
				: spans(`messaging.destination.name = ${value}`)
		case "rpc":
			return namedBySystem
				? spans(`rpc.system = ${value}`, `(rpc.service = ${value} OR rpc.service !exists)`)
				: spans(`rpc.service = ${value}`)
		case "http":
			return spans(`server.address = ${value}`)
	}
}
