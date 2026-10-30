import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, type IconName } from "../../../ui/icon"

// `GcpServiceIcon`: the service glyph as a tile, or a Cloud SQL instance's engine logo once the
// inventory knows it.

const SERVICE_ICON = {
	cloudRun: "CloudRunIcon",
	cloudFunctions: "ParenthesesDotsIcon",
	gke: "GkeIcon",
	computeEngine: "MicrochipIcon",
	cloudSql: "DatabaseIcon",
	pubsub: "GooglePubSubIcon",
	loadBalancing: "SitemapIcon",
} as const satisfies Record<GcpInfraServiceId, IconName>

const ENGINE_ICON: ReadonlyArray<readonly [prefix: string, icon: IconName]> = [
	["POSTGRES", "PostgresIcon"],
	["MYSQL", "MysqlDolphinIcon"],
	["SQLSERVER", "SqlServerIcon"],
]

const TILE = {
	sm: { box: "size-6 rounded-md", icon: 13 },
	md: { box: "size-7 rounded-md", icon: 15 },
	lg: { box: "size-9 rounded-lg", icon: 20 },
} as const

const engineIcon = (databaseVersion: string | null | undefined): IconName | undefined =>
	databaseVersion === null || databaseVersion === undefined
		? undefined
		: ENGINE_ICON.find(([prefix]) => databaseVersion.startsWith(prefix))?.[1]

export const gcpServiceIcon = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		service: GcpInfraServiceId
		databaseVersion?: string | null
		size?: keyof typeof TILE
		className?: string
	}>,
): Html => {
	const name =
		(options.service === "cloudSql" ? engineIcon(options.databaseVersion) : undefined) ??
		SERVICE_ICON[options.service]
	const tile = TILE[options.size ?? "md"]
	return h.span(
		[
			h.AriaHidden(true),
			h.Class(
				cn(
					"flex shrink-0 items-center justify-center border bg-muted/40 text-foreground/70",
					tile.box,
					options.className,
				),
			),
		],
		[icon(h, name, { size: tile.icon })],
	)
}
