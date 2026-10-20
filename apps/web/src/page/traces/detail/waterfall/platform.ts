import { getCloudPlatform, pickAttr } from "../../../../service-map/trace-flow/cloud-platforms"
import type { IconName } from "../../../../ui/icon"

// The `CloudPlatformInfo` fields a span row reads. The flow port's copy of the adapters gives
// label, icon, edge and outcome; accent and location are copied from
// packages/ui/src/lib/cloud-platforms/{database,cloudflare}.ts (they import React icons).

// copied: DB_SYSTEM_ACCENTS (database.ts).
const DB_SYSTEM_ACCENTS = new Map([
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

export interface RowPlatform {
	readonly label: string
	readonly icon: IconName
	readonly accentClassName: string
	readonly edge: string | null
	readonly location: string | null
	readonly outcome: { readonly value: string; readonly bad: boolean } | null
}

export const rowPlatform = (attrs: Record<string, string>): RowPlatform | null => {
	const platform = getCloudPlatform(attrs)
	if (platform === null) return null
	if (platform.id === "cloudflare") {
		const location = [pickAttr(attrs, "geo.locality.name"), pickAttr(attrs, "geo.country.code")]
			.filter((part) => part !== null && part !== "")
			.join(", ")
		return { ...platform, accentClassName: "text-[#F38020]", location: location === "" ? null : location }
	}
	const system = (pickAttr(attrs, "db.system.name", "db.system") ?? "").toLowerCase()
	return {
		...platform,
		accentClassName: DB_SYSTEM_ACCENTS.get(system) ?? "text-muted-foreground",
		location: null,
	}
}
