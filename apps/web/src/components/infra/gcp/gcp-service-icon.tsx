// The glyph of each Google Cloud service the infrastructure page lists, and of a Cloud SQL
// instance's engine.

import type { GcpInfraServiceId } from "@maple/domain/gcp-infra"
import { cn } from "@maple/ui/lib/utils"

import {
	DatabaseIcon,
	KubernetesIcon,
	MicrochipIcon,
	PostgresIcon,
	type IconComponent,
	type IconProps,
} from "@/components/icons"
// Not in the icons barrel, whose chunk loads at startup: only these pages draw them.
import { CloudRunIcon } from "@/components/icons/cloud-run"
import { GooglePubSubIcon } from "@/components/icons/google-pubsub"
import { MysqlDolphinIcon } from "@/components/icons/mysql-dolphin"
import { ParenthesesDotsIcon } from "@/components/icons/parentheses-dots"
import { SqlServerIcon } from "@/components/icons/sql-server"
import { SitemapIcon } from "@maple/ui/components/icons"

/** The Kubernetes wheel in the text colour, like the other service glyphs. */
const GkeIcon = (props: IconProps) => <KubernetesIcon fill="currentColor" {...props} />

const GCP_SERVICE_ICON = {
	cloudRun: CloudRunIcon,
	cloudFunctions: ParenthesesDotsIcon,
	gke: GkeIcon,
	computeEngine: MicrochipIcon,
	cloudSql: DatabaseIcon,
	pubsub: GooglePubSubIcon,
	loadBalancing: SitemapIcon,
} satisfies Record<GcpInfraServiceId, IconComponent>

const ENGINE_ICON: ReadonlyArray<readonly [prefix: string, icon: IconComponent]> = [
	["POSTGRES", PostgresIcon],
	["MYSQL", MysqlDolphinIcon],
	["SQLSERVER", SqlServerIcon],
]

/** A Cloud SQL instance's engine logo, from its `databaseVersion` (`POSTGRES_15`); none while unknown. */
const gcpSqlEngineIcon = (databaseVersion: string | null | undefined): IconComponent | undefined =>
	databaseVersion == null
		? undefined
		: ENGINE_ICON.find(([prefix]) => databaseVersion.startsWith(prefix))?.[1]

const TILE = {
	sm: { box: "size-6 rounded-md", icon: 13 },
	md: { box: "size-7 rounded-md", icon: 15 },
	lg: { box: "size-9 rounded-lg", icon: 20 },
}

/**
 * A workload's service as a tile: the service glyph, or for a Cloud SQL instance its engine's
 * logo once the inventory knows it.
 */
export function GcpServiceIcon({
	service,
	databaseVersion,
	size = "md",
	className,
}: {
	service: GcpInfraServiceId
	databaseVersion?: string | null
	size?: keyof typeof TILE
	className?: string
}) {
	const Icon =
		(service === "cloudSql" ? gcpSqlEngineIcon(databaseVersion) : undefined) ?? GCP_SERVICE_ICON[service]
	const tile = TILE[size]
	return (
		<span
			aria-hidden
			className={cn(
				"flex shrink-0 items-center justify-center border bg-muted/40 text-foreground/75",
				tile.box,
				className,
			)}
		>
			<Glyph icon={Icon} size={tile.icon} />
		</span>
	)
}

function Glyph({ icon: Icon, size }: { icon: IconComponent; size: number }) {
	return <Icon size={size} />
}
