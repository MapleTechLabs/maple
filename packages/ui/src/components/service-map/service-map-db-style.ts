import { HYPERDRIVE_DB_NAMESPACE } from "@maple/domain/tinybird/db-query-shape-sql"

// Framework-free half of `service-map-db.tsx`: colors, labels and an icon KEY per
// db system. The React module maps keys to icon components; other renderers
// (the Foldkit app) map them to their own glyphs.

/** PlanetScale's neutral brand accent (DB node stripe, minimap, sidebar icon). */
export const PLANETSCALE_COLOR = "oklch(0.62 0.02 270)"

/** Cloudflare brand orange: the collapsed Hyperdrive node and the Worker overlay accent. */
export const CLOUDFLARE_COLOR = "oklch(0.7 0.16 50)"

export type DbCategory = "database" | "cache" | "queue" | "search"

export type DbIconKey =
	| "postgres"
	| "mysql"
	| "clickhouse"
	| "mongodb"
	| "redis"
	| "database"
	| "fire"
	| "paper-plane"
	| "magnifier"
	| "cloudflare"
	| "planetscale"

export interface DbStyle {
	/** Coarse classification used for the node's silhouette label + fallback icon. */
	category: DbCategory
	/** Branded icon when the system is recognised, otherwise a generic category icon. */
	icon: DbIconKey
	/** Friendly display name (e.g. "PostgreSQL"). */
	label: string
	/** Per-system brand color, used for the accent stripe / minimap / edge endpoints. */
	color: string
	/** Whether the icon carries its own brand colors (so callers shouldn't recolor it). */
	branded: boolean
}

const CATEGORY_COLOR: Record<DbCategory, string> = {
	database: "oklch(0.62 0.12 255)",
	cache: "oklch(0.62 0.19 30)",
	queue: "oklch(0.64 0.15 300)",
	search: "oklch(0.68 0.12 195)",
} satisfies Record<DbCategory, string>

const CATEGORY_ICON: Record<DbCategory, DbIconKey> = {
	database: "database",
	cache: "fire",
	queue: "paper-plane",
	search: "magnifier",
} satisfies Record<DbCategory, DbIconKey>

const CATEGORY_FALLBACK_LABEL: Record<DbCategory, string> = {
	database: "Database",
	cache: "Cache",
	queue: "Queue",
	search: "Search",
} satisfies Record<DbCategory, string>

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
export function getDbStyle(system: string | undefined): DbStyle {
	const s = (system ?? "").trim().toLowerCase()

	switch (s) {
		case "postgresql":
		case "postgres":
			return {
				category: "database",
				icon: "postgres",
				label: "PostgreSQL",
				color: "oklch(0.6 0.12 255)",
				branded: true,
			}
		case "mysql":
		case "mariadb":
			return {
				category: "database",
				icon: "mysql",
				label: s === "mariadb" ? "MariaDB" : "MySQL",
				color: "oklch(0.62 0.1 215)",
				branded: true,
			}
		case "clickhouse":
			return {
				category: "database",
				icon: "clickhouse",
				label: "ClickHouse",
				color: "oklch(0.8 0.16 95)",
				branded: true,
			}
		case "mongodb":
			return {
				category: "database",
				icon: "mongodb",
				label: "MongoDB",
				color: "oklch(0.66 0.16 150)",
				branded: true,
			}
		case "redis":
			return {
				category: "cache",
				icon: "redis",
				label: "Redis",
				color: "oklch(0.58 0.2 25)",
				branded: true,
			}
		case "tinybird":
			// No Nucleo/brand icon for Tinybird yet, so the generic database glyph
			// carries the brand color rather than shipping an invented mark. The
			// case still earns its keep: without it the node renders the raw
			// lowercase `tinybird` in the default database blue.
			return {
				category: "database",
				icon: "database",
				label: "Tinybird",
				color: "oklch(0.82 0.19 155)",
				branded: false,
			}
	}

	const category = categoryOf(s)
	return {
		category,
		icon: CATEGORY_ICON[category],
		label: system ?? CATEGORY_FALLBACK_LABEL[category],
		color: CATEGORY_COLOR[category],
		branded: false,
	}
}

/** Everything a DB node / detail-panel header needs to render, brand included. */
export interface DbNodeStyle {
	/** Node title: the database identity, or "Hyperdrive" for the collapsed proxy node. */
	title: string
	/** Small uppercase badge: the underlying system, or the coarse category. */
	badge: string
	icon: DbIconKey
	color: string
	branded: boolean
	category: DbCategory
	/** Tooltip / long-form label (e.g. "PostgreSQL via Hyperdrive"). */
	systemLabel: string
}

/**
 * How a database node is presented, given its system and namespace. The
 * `HYPERDRIVE_DB_NAMESPACE` sentinel (every Hyperdrive config collapses to it)
 * brands the node as Hyperdrive with the underlying system kept in the badge.
 */
export function resolveDbNodeStyle(
	dbSystem: string | undefined,
	dbNamespace: string | undefined,
): DbNodeStyle {
	const ns = dbNamespace ?? ""
	const sys = getDbStyle(dbSystem)
	if (ns === HYPERDRIVE_DB_NAMESPACE) {
		return {
			title: "Hyperdrive",
			badge: sys.label,
			icon: "cloudflare",
			color: CLOUDFLARE_COLOR,
			branded: true,
			category: sys.category,
			systemLabel: `${sys.label} via Hyperdrive`,
		}
	}
	return {
		title: ns || dbSystem || sys.label,
		badge: ns ? sys.label : sys.category,
		icon: sys.icon,
		color: sys.color,
		branded: sys.branded,
		category: sys.category,
		systemLabel: sys.label,
	}
}

/** Node color with a neutral fallback for unknown systems, honoring the Hyperdrive collapse. */
export function getDbNodeColor(system: string | undefined, namespace: string): string {
	return resolveDbNodeStyle(system, namespace).color
}

/** A DB node matched against the org's PlanetScale inventory; `kind` wins over an ambiguous `dbSystem`. */
export function resolvePlanetScaleDbStyle(
	dbSystem: string | undefined,
	dbNamespace: string | undefined,
	kind: string | undefined,
): DbNodeStyle {
	const sys = getDbStyle(dbSystem || (kind === "postgresql" ? "postgresql" : "mysql"))
	return {
		title: dbNamespace || sys.label,
		badge: "PlanetScale",
		icon: "planetscale",
		color: PLANETSCALE_COLOR,
		branded: false,
		category: "database",
		systemLabel: `${sys.label} on PlanetScale`,
	}
}

/** Append an alpha channel to an `oklch(L C H)` color string. */
export function withAlpha(color: string, alpha: number): string {
	return color.replace(/\)\s*$/, ` / ${alpha})`)
}
