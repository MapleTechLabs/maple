// Brand accents for the trace platform annotations. Kept free of React imports so the Foldkit
// dashboard reads the same values as the React adapters instead of copying them.

export const CLOUDFLARE_ACCENT_CLASS = "text-[#F38020]"

// Brand-ish accent per `db.system`; a small tint on the 12px icon, muted otherwise.
const DB_SYSTEM_ACCENTS: ReadonlyMap<string, string> = new Map([
	["postgresql", "text-[#336791]"],
	["mysql", "text-[#00758F]"],
	["mariadb", "text-[#1F7A8C]"],
	["clickhouse", "text-[#F5B400]"],
	["redis", "text-[#DC382D]"],
	["mongodb", "text-[#13AA52]"],
	["elasticsearch", "text-[#00BFB3]"],
	["opensearch", "text-[#00BFB3]"],
	["cassandra", "text-[#1287B1]"],
	["cockroachdb", "text-[#6933FF]"],
	["sqlite", "text-[#0F80CC]"],
	["oracle", "text-[#C74634]"],
	["mssql", "text-[#CC2927]"],
	["microsoft.sql_server", "text-[#CC2927]"],
	["dynamodb", "text-[#4053D6]"],
	["aws.dynamodb", "text-[#4053D6]"],
	["redshift", "text-[#8C4FFF]"],
	["snowflake", "text-[#29B5E8]"],
])

export const dbSystemAccentClass = (system: string): string =>
	DB_SYSTEM_ACCENTS.get(system.toLowerCase()) ?? "text-muted-foreground"
