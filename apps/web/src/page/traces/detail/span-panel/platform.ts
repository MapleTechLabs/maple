import type { IconName } from "../../../../ui/icon"

// copied: packages/ui/src/lib/cloud-platforms/{types,cloudflare,database}.ts with `Icon` as an
// icon name (the adapters import React icon components). The detail panel reads every field.

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
		? "bg-severity-error/15 text-severity-error border-severity-error/30"
		: "bg-severity-info/15 text-severity-info border-severity-info/30"

type Attrs = Readonly<Record<string, string>>

const pickAttr = (attrs: Attrs, ...keys: ReadonlyArray<string>): string | null =>
	keys
		.map((key) => attrs[key])
		.find((value): value is string => value !== undefined && value.trim() !== "") ?? null

const joinEdge = (...parts: ReadonlyArray<string | null>): string | null =>
	parts.filter((p): p is string => p !== null && p.trim() !== "").join(" · ") || null

const cloudflare = (attrs: Attrs): PlatformInfo | null => {
	const isWorker =
		attrs["cloud.platform"] === "cloudflare.workers" ||
		Object.entries(attrs).some(([k, v]) => k.startsWith("cloudflare.") && v.trim() !== "")
	if (!isWorker) return null
	const country = pickAttr(attrs, "geo.country.code")
	const city = pickAttr(attrs, "geo.locality.name")
	const outcome = pickAttr(attrs, "cloudflare.outcome")
	const scriptName = pickAttr(attrs, "cloudflare.script_name", "faas.name")
	const scriptVersion = pickAttr(attrs, "cloudflare.script_version.id", "faas.version")
	const model = pickAttr(attrs, "cloudflare.execution_model")
	const handler = pickAttr(attrs, "cloudflare.handler_type", "faas.trigger")
	const cpu = pickAttr(attrs, "cpu_time_ms")
	const wall = pickAttr(attrs, "wall_time_ms")
	const ttfb = pickAttr(attrs, "cloudflare.response.time_to_first_byte_ms")
	const rayId = pickAttr(attrs, "cloudflare.ray_id")
	const fields: ReadonlyArray<PlatformField | null> = [
		scriptName === null ? null : { label: "Script", value: scriptName },
		scriptVersion === null
			? null
			: { label: "Version", value: scriptVersion, display: scriptVersion.slice(0, 8), copyable: true },
		model === null ? null : { label: "Model", value: model },
		handler === null ? null : { label: "Handler", value: handler },
		cpu === null
			? null
			: { label: "CPU / Wall", value: wall === null ? `${cpu}ms` : `${cpu}ms / ${wall}ms` },
		ttfb === null ? null : { label: "TTFB", value: `${ttfb}ms` },
		rayId === null ? null : { label: "Ray ID", value: rayId, copyable: true, wide: true },
	]
	return {
		label: "Cloudflare Worker",
		icon: "CloudflareIcon",
		accentClassName: "text-[#F38020]",
		edge: joinEdge(pickAttr(attrs, "cloudflare.colo"), pickAttr(attrs, "faas.invoked_region")),
		location: [city, country].filter(Boolean).join(", ") || null,
		outcome: outcome === null ? null : { value: outcome, bad: outcome.toLowerCase() !== "ok" },
		fields: fields.filter((field): field is PlatformField => field !== null),
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

const DB_SYSTEM_ACCENTS = new Map(
	Object.entries({
		postgresql: "text-[#336791]",
		mysql: "text-[#00758F]",
		mariadb: "text-[#1F7A8C]",
		clickhouse: "text-[#F5B400]",
		redis: "text-[#DC382D]",
		mongodb: "text-[#13AA52]",
		elasticsearch: "text-[#00BFB3]",
		opensearch: "text-[#00BFB3]",
		cassandra: "text-[#1287B1]",
		cockroachdb: "text-[#6933FF]",
		sqlite: "text-[#0F80CC]",
		oracle: "text-[#C74634]",
		mssql: "text-[#CC2927]",
		"microsoft.sql_server": "text-[#CC2927]",
		dynamodb: "text-[#4053D6]",
		"aws.dynamodb": "text-[#4053D6]",
		redshift: "text-[#8C4FFF]",
		snowflake: "text-[#29B5E8]",
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
		accentClassName: DB_SYSTEM_ACCENTS.get(system.toLowerCase()) ?? "text-muted-foreground",
		edge: null,
		location: null,
		outcome: errorType === null ? null : { value: errorType, bad: true },
		fields: fields.filter((field): field is PlatformField => field !== null),
	}
}

/** `getCloudPlatform`: the first adapter that recognizes these span attributes. */
export const getCloudPlatform = (attrs: Attrs): PlatformInfo | null => cloudflare(attrs) ?? database(attrs)
