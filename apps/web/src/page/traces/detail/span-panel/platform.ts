import { CLOUDFLARE_ACCENT_CLASS, dbSystemAccentClass } from "@maple/ui/lib/cloud-platforms/accents"
import { cloudflareDisplay } from "@maple/ui/lib/cloud-platforms/cloudflare-display"
import { detectCloudflareWorker } from "@maple/domain/cloud-platform"
import type { IconName } from "../../../../ui/icon"

// copied: packages/ui/src/lib/cloud-platforms/{types,database}.ts with `Icon` as an icon name
// (the adapters import React icon components). Workers detection and rows are shared.

export interface PlatformField {
	readonly label: string
	readonly value: string
	readonly display?: string
	readonly copyable?: boolean
	readonly wide?: boolean
}

export interface PlatformInfo {
	readonly label: string
	readonly icon: IconName
	readonly accentClassName: string
	readonly edge: string | null
	readonly location: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
	readonly fields: ReadonlyArray<PlatformField>
}

export const outcomeBadgeStyle = (bad: boolean): string =>
	bad
		? "bg-severity-error-a2 text-severity-error border-severity-error-a3"
		: "bg-severity-info-a2 text-severity-info border-severity-info-a3"

type Attrs = Readonly<Record<string, string>>

const pickAttr = (attrs: Attrs, ...keys: ReadonlyArray<string>): string | null =>
	keys
		.map((key) => attrs[key])
		.find((value): value is string => value !== undefined && value.trim() !== "") ?? null

const cloudflare = (attrs: Attrs): PlatformInfo | null => {
	const worker = detectCloudflareWorker(attrs)
	if (worker === undefined) return null
	return {
		label: "Cloudflare Worker",
		icon: "CloudflareIcon",
		accentClassName: CLOUDFLARE_ACCENT_CLASS,
		...cloudflareDisplay(worker),
	}
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

const humanizeDbSystem = (system: string): string =>
	DB_SYSTEM_LABELS.get(system.toLowerCase()) ??
	(system.split(".").pop() ?? system)
		.split(/[_\s-]+/)
		.filter(Boolean)
		.map((w) => w.charAt(0).toUpperCase() + w.slice(1))
		.join(" ")

const database = (attrs: Attrs): PlatformInfo | null => {
	const system = pickAttr(attrs, "db.system.name", "db.system")
	if (system === null) return null
	const operation = pickAttr(attrs, "db.operation.name", "db.operation")
	const namespace = pickAttr(attrs, "db.namespace")
	const collection = pickAttr(attrs, "db.collection.name")
	const rows = pickAttr(attrs, "db.response.returned_rows")
	const batch = pickAttr(attrs, "db.operation.batch.size")
	const statusCode = pickAttr(attrs, "db.response.status_code")
	const serverAddress = pickAttr(attrs, "server.address", "network.peer.address")
	const serverPort = pickAttr(attrs, "server.port", "network.peer.port")
	const errorType = pickAttr(attrs, "error.type")
	const fields: ReadonlyArray<PlatformField | null> = [
		operation === null ? null : { label: "Operation", value: operation },
		namespace === null ? null : { label: "Namespace", value: namespace },
		collection === null ? null : { label: "Table", value: collection },
		rows === null ? null : { label: "Rows returned", value: rows },
		batch === null ? null : { label: "Batch size", value: batch },
		serverAddress === null
			? null
			: {
					label: "Server",
					value: serverPort === null ? serverAddress : `${serverAddress}:${serverPort}`,
					copyable: true,
				},
		statusCode === null ? null : { label: "Status", value: statusCode },
	]
	return {
		label: humanizeDbSystem(system),
		icon: "DatabaseIcon",
		accentClassName: dbSystemAccentClass(system),
		edge: null,
		location: null,
		outcome: errorType === null ? null : { value: errorType, bad: true },
		fields: fields.filter((field): field is PlatformField => field !== null),
	}
}

/** `getCloudPlatform`: the first adapter that recognizes these span attributes. */
export const getCloudPlatform = (attrs: Attrs): PlatformInfo | null => cloudflare(attrs) ?? database(attrs)
