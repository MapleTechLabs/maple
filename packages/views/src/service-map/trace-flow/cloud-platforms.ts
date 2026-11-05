import { cloudflareDisplay } from "@maple/ui/lib/cloud-platforms/cloudflare-display"
import { detectCloudflareWorker } from "@maple/domain/cloud-platform"
import type { FlowIconName } from "../../ui/flow-icons"
import { Array as Arr, Option, Record as Rec, String as Str } from "effect"

// copied: packages/ui/src/lib/cloud-platforms/{database,index}.ts, the fields the flow card
// reads, with `Icon` as an icon name (the adapters import React icon components). Workers
// detection is shared with the adapters through `@maple/domain/cloud-platform`.

export interface CloudPlatformInfo {
	readonly id: string
	readonly label: string
	readonly kind: string
	readonly icon: FlowIconName
	readonly edge: string | null
	readonly location: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
}

const DB_SYSTEM_LABELS = new Map<string, string>(
	Rec.toEntries({
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

export function humanizeDbSystem(system: string): string {
	const known = DB_SYSTEM_LABELS.get(Str.toLowerCase(system))
	if (known) return known
	return Arr.join(
		Arr.map(
			Arr.filter(Str.split(/[_\s-]+/)(Arr.lastNonEmpty(Str.split(".")(system))), (word) => word !== ""),
			(word) => Str.toUpperCase(Str.slice(0, 1)(word)) + Str.slice(1)(word),
		),
		" ",
	)
}

/** First present, non-blank value among `keys`. */
export const pickAttr = (attrs: Record<string, string>, ...keys: ReadonlyArray<string>): string | null =>
	Option.getOrNull(
		Arr.findFirst(
			Arr.map(keys, (key) => attrs[key]),
			(value) => value != null && Str.trim(value) !== "",
		),
	)

const cloudflare = (attrs: Record<string, string>): CloudPlatformInfo | null => {
	const worker = detectCloudflareWorker(attrs)
	if (worker === undefined) return null
	const { edge, location, outcome } = cloudflareDisplay(worker)
	return {
		id: "cloudflare",
		label: "Cloudflare Worker",
		kind: "Worker",
		icon: "CloudflareIcon",
		edge,
		location,
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
		location: null,
		outcome: errorType ? { value: errorType, bad: true } : null,
	}
}

/** First adapter that recognizes these span attributes, normalized; else null. */
export function getCloudPlatform(attrs: Record<string, string>): CloudPlatformInfo | null {
	return cloudflare(attrs) ?? database(attrs)
}
