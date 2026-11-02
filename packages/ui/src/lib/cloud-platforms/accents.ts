// Brand accents for the trace platform annotations. Kept free of React imports so the Foldkit
// dashboard reads the same values as the React adapters instead of copying them.

export const CLOUDFLARE_ACCENT_CLASS = "text-brand-cloudflare"

// Brand-ish accent per `db.system`; a small tint on the 12px icon, muted otherwise.
const DB_SYSTEM_ACCENTS: ReadonlyMap<string, string> = new Map([
	["postgresql", "text-brand-postgresql"],
	["mysql", "text-brand-mysql"],
	["mariadb", "text-brand-mariadb"],
	["clickhouse", "text-brand-clickhouse"],
	["redis", "text-brand-redis"],
	["mongodb", "text-brand-mongodb"],
	["elasticsearch", "text-brand-elastic"],
	["opensearch", "text-brand-elastic"],
	["cassandra", "text-brand-cassandra"],
	["cockroachdb", "text-brand-cockroachdb"],
	["sqlite", "text-brand-sqlite"],
	["oracle", "text-brand-oracle"],
	["mssql", "text-brand-mssql"],
	["microsoft.sql_server", "text-brand-mssql"],
	["dynamodb", "text-brand-dynamodb"],
	["aws.dynamodb", "text-brand-dynamodb"],
	["redshift", "text-brand-redshift"],
	["snowflake", "text-brand-snowflake"],
])

export const dbSystemAccentClass = (system: string): string =>
	DB_SYSTEM_ACCENTS.get(system.toLowerCase()) ?? "text-muted-foreground"
