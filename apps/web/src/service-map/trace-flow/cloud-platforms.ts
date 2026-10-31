import { cloudflareDisplay } from "@maple/ui/lib/cloud-platforms/cloudflare-display"
import { detectCloudflareWorker } from "@maple/domain/cloud-platform"
import type { IconName } from "../../ui/icon"

// copied: packages/ui/src/lib/cloud-platforms/{database,index}.ts, the fields the flow card
// reads, with `Icon` as an icon name (the adapters import React icon components). Workers
// detection is shared with the adapters through `@maple/domain/cloud-platform`.

export interface CloudPlatformInfo {
	readonly id: string
	readonly label: string
	readonly kind: string
	readonly icon: IconName
	readonly edge: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
}

const DB_SYSTEM_LABELS = new Map(
	Object.entries({
		postgresql: "PostgreSQL",
		mysql: "MySQL",
		mariadb: "MariaDB",
		clickhouse: "ClickHouse",
		redis: "Redis",
		mongodb: "MongoDB",
		elasticsearch: "Elasticsearch",
		opensearch: "OpenSearch",
		cassandra: "Cassandra",
		cockroachdb: "CockroachDB",
		sqlite: "SQLite",
		oracle: "Oracle",
		db2: "Db2",
		"microsoft.sql_server": "SQL Server",
		mssql: "SQL Server",
		"aws.dynamodb": "DynamoDB",
		dynamodb: "DynamoDB",
		"aws.redshift": "Redshift",
		redshift: "Redshift",
		"gcp.spanner": "Spanner",
		"azure.cosmosdb": "Cosmos DB",
		cosmosdb: "Cosmos DB",
		memcached: "Memcached",
		couchbase: "Couchbase",
		couchdb: "CouchDB",
		neo4j: "Neo4j",
		snowflake: "Snowflake",
		trino: "Trino",
		presto: "Presto",
		hive: "Hive",
		spanner: "Spanner",
	}),
)

function humanizeDbSystem(system: string): string {
	const known = DB_SYSTEM_LABELS.get(system.toLowerCase())
	if (known) return known
	const tail = system.split(".").pop() ?? system
	return tail
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ")
}

/** First present, non-blank value among `keys`. */
export const pickAttr = (attrs: Record<string, string>, ...keys: ReadonlyArray<string>): string | null =>
	keys.map((key) => attrs[key]).find((value) => value != null && value.trim() !== "") ?? null

const cloudflare = (attrs: Record<string, string>): CloudPlatformInfo | null => {
	const worker = detectCloudflareWorker(attrs)
	if (worker === undefined) return null
	const { edge, outcome } = cloudflareDisplay(worker)
	return {
		id: "cloudflare",
		label: "Cloudflare Worker",
		kind: "Worker",
		icon: "CloudflareIcon",
		edge,
		outcome,
	}
}

const database = (attrs: Record<string, string>): CloudPlatformInfo | null => {
	const system = pickAttr(attrs, "db.system.name", "db.system")
	if (!system) return null
	const errorType = pickAttr(attrs, "error.type")
	return {
		id: "database",
		label: humanizeDbSystem(system),
		kind: "Query",
		icon: "DatabaseIcon",
		edge: null,
		outcome: errorType ? { value: errorType, bad: true } : null,
	}
}

/** First adapter that recognizes these span attributes, normalized; else null. */
export function getCloudPlatform(attrs: Record<string, string>): CloudPlatformInfo | null {
	return cloudflare(attrs) ?? database(attrs)
}
