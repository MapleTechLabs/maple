import {
	ClickhouseIcon,
	DatabaseIcon,
	FireIcon,
	type IconComponent,
	MagnifierIcon,
	MongodbIcon,
	MysqlIcon,
	PaperPlaneIcon,
	PostgresIcon,
	RedisIcon,
} from "@/components/icons"

export type DbCategory = "database" | "cache" | "queue" | "search"

export interface DbDescriptor {
	/** Coarse classification used for the node's silhouette label + fallback icon. */
	category: DbCategory
	/** Branded icon when the system is recognised, otherwise a generic category icon. */
	Icon: IconComponent
	/** Friendly display name (e.g. "PostgreSQL"). */
	label: string
	/** Per-system brand color, used for the accent stripe / minimap / edge endpoints. */
	color: string
	/** Whether `Icon` carries its own brand colors (so callers shouldn't recolor it). */
	branded: boolean
}

const CATEGORY_COLOR: Record<DbCategory, string> = {
	database: "oklch(0.62 0.12 255)",
	cache: "oklch(0.62 0.19 30)",
	queue: "oklch(0.64 0.15 300)",
	search: "oklch(0.68 0.12 195)",
}

const CATEGORY_ICON: Record<DbCategory, IconComponent> = {
	database: DatabaseIcon,
	cache: FireIcon,
	queue: PaperPlaneIcon,
	search: MagnifierIcon,
}

const CATEGORY_FALLBACK_LABEL: Record<DbCategory, string> = {
	database: "Database",
	cache: "Cache",
	queue: "Queue",
	search: "Search",
}

const CACHE_SYSTEMS = new Set(["redis", "memcached", "hazelcast"])
const QUEUE_SYSTEMS = new Set(["kafka", "rabbitmq", "pulsar", "nats", "activemq", "sqs"])
const SEARCH_SYSTEMS = new Set(["elasticsearch", "opensearch", "solr"])

function categoryOf(system: string): DbCategory {
	if (CACHE_SYSTEMS.has(system)) return "cache"
	if (QUEUE_SYSTEMS.has(system)) return "queue"
	if (SEARCH_SYSTEMS.has(system)) return "search"
	return "database"
}

/**
 * Resolve presentation metadata for a `db.system` value. Shared by the service-map
 * node, the inbound edges, and the database detail panel so the icon, color, and
 * category label always agree.
 */
export function getDbDescriptor(system: string | undefined): DbDescriptor {
	const s = (system ?? "").toLowerCase()

	switch (s) {
		case "postgresql":
		case "postgres":
			return {
				category: "database",
				Icon: PostgresIcon,
				label: "PostgreSQL",
				color: "oklch(0.6 0.12 255)",
				branded: true,
			}
		case "mysql":
		case "mariadb":
			return {
				category: "database",
				Icon: MysqlIcon,
				label: s === "mariadb" ? "MariaDB" : "MySQL",
				color: "oklch(0.62 0.1 215)",
				branded: true,
			}
		case "clickhouse":
			return {
				category: "database",
				Icon: ClickhouseIcon,
				label: "ClickHouse",
				color: "oklch(0.8 0.16 95)",
				branded: true,
			}
		case "mongodb":
			return {
				category: "database",
				Icon: MongodbIcon,
				label: "MongoDB",
				color: "oklch(0.66 0.16 150)",
				branded: true,
			}
		case "redis":
			return {
				category: "cache",
				Icon: RedisIcon,
				label: "Redis",
				color: "oklch(0.58 0.2 25)",
				branded: true,
			}
	}

	const category = categoryOf(s)
	return {
		category,
		Icon: CATEGORY_ICON[category],
		label: system ?? CATEGORY_FALLBACK_LABEL[category],
		color: CATEGORY_COLOR[category],
		branded: false,
	}
}

/** Per-system brand color with a neutral fallback for unknown systems. */
export function getDbColor(system: string | undefined): string {
	return getDbDescriptor(system).color
}

/** Append an alpha channel to an `oklch(L C H)` color string. */
export function withAlpha(color: string, alpha: number): string {
	return color.replace(/\)\s*$/, ` / ${alpha})`)
}
