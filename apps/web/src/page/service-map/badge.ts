import { getDbStyle } from "@maple/ui/components/service-map/service-map-db-style"
import type { Node3D } from "../../components/service-map/three/types"
import { resolveRuntimeGlyph } from "../../service-map/map/runtime"

// copied: `resolveMachineBadge` (components/service-map/three/factory-badge.ts) with the artwork as
// a key: the labels need only the name, and the mark paths load with the 3D scene chunk.

export type MarkKey =
	| "kafka"
	| "nats"
	| "rabbitmq"
	| "postgres"
	| "mysql"
	| "clickhouse"
	| "mongodb"
	| "redis"
	| "openjdk"
	| "nodejs"
	| "bun"
	| "deno"
	| "cloudflare"
	| "rust"
	| "python"
	| "ruby"

export type BadgeArt = {
	readonly label: string
} & (
	| { readonly mark: MarkKey; readonly wordmark?: never }
	| { readonly wordmark: string; readonly mark?: never }
)

const DB_MARKS: ReadonlyMap<string, MarkKey> = new Map<string, MarkKey>([
	["postgres", "postgres"],
	["mysql", "mysql"],
	["clickhouse", "clickhouse"],
	["mongodb", "mongodb"],
	["redis", "redis"],
])

const RUNTIME_MARKS: ReadonlyMap<string, MarkKey> = new Map<string, MarkKey>([
	["OpenjdkMonoIcon", "openjdk"],
	["NodejsMonoIcon", "nodejs"],
	["BunIcon", "bun"],
	["DenoIcon", "deno"],
	["CloudflareMonoIcon", "cloudflare"],
	["RustIcon", "rust"],
	["PythonIcon", "python"],
	["RubyIcon", "ruby"],
])

/** Only identified technologies get a plate. A database's system always wins
 * over runtime metadata, which can belong to the client querying it. */
export function machineBadge(node: Pick<Node3D, "kind" | "system" | "runtime">): BadgeArt | null {
	if (node.system || node.kind === "database" || node.kind === "queue") {
		const system = node.system?.trim().toLowerCase()
		switch (system) {
			case "kafka":
				return { label: "Kafka", mark: "kafka" }
			case "nats":
				return { label: "NATS", mark: "nats" }
			case "rabbitmq":
				return { label: "RabbitMQ", mark: "rabbitmq" }
		}
		const database = getDbStyle(system)
		const mark = DB_MARKS.get(database.icon)
		return mark === undefined ? null : { label: database.label, mark }
	}
	const runtime = node.runtime && resolveRuntimeGlyph(node.runtime)
	if (!runtime) return null
	const mark = runtime.icon === null ? undefined : RUNTIME_MARKS.get(runtime.icon)
	return mark !== undefined
		? { label: runtime.full, mark }
		: { label: runtime.full, wordmark: runtime.full.length <= 6 ? runtime.full : runtime.short }
}
