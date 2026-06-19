import { motion } from "motion/react"

import { Badge } from "@maple/ui/components/ui/badge"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import {
	CloudflareIcon,
	GithubIcon,
	HazelIcon,
	PlanetScaleIcon,
	PrometheusIcon,
	WarpStreamIcon,
} from "@/components/icons"
import { Result, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient } from "@/lib/services/common/atom-client"
import { GITHUB_ACCENT } from "./github-integration-card"
import { HAZEL_ACCENT } from "./hazel-integration-card"

export type IntegrationId =
	| "cloudflare"
	| "prometheus"
	| "planetscale"
	| "warpstream"
	| "hazel"
	| "github"

export interface CatalogEntry {
	readonly id: IntegrationId
	readonly name: string
	readonly description: string
	readonly icon: React.ComponentType<{ size?: number; className?: string }>
	/** Brand accent for the icon plate wash (third-party colors, no app token applies). */
	readonly accent: string
	readonly docsUrl?: string
}

const CATALOG: ReadonlyArray<CatalogEntry> = [
	{
		id: "cloudflare",
		name: "Cloudflare Logpush",
		description: "Receive Cloudflare HTTP request logs over HTTPS and map them into Maple logs.",
		icon: CloudflareIcon,
		accent: "#F38020",
	},
	{
		id: "prometheus",
		name: "Prometheus",
		description: "Scrape any Prometheus-compatible endpoint on a schedule — no collector required.",
		icon: PrometheusIcon,
		accent: "#E6522C",
		docsUrl: "https://maple.dev/docs/integrations/prometheus",
	},
	{
		id: "planetscale",
		name: "PlanetScale",
		description:
			"Connect an organization with a service token — Maple discovers and scrapes every database branch.",
		icon: PlanetScaleIcon,
		// PlanetScale's mark is monochrome — neutral wash that works in both themes.
		accent: "#8B8B8B",
		docsUrl: "https://maple.dev/docs/integrations/planetscale",
	},
	{
		id: "warpstream",
		name: "WarpStream",
		description: "Monitor WarpStream clusters via agent metrics or the hosted Prometheus endpoint.",
		icon: WarpStreamIcon,
		// WarpStream's brand crimson (fill of the official mark).
		accent: "#E52344",
		docsUrl: "https://maple.dev/docs/integrations/warpstream",
	},
	{
		id: "hazel",
		name: "Hazel",
		description:
			"Forward Maple alerts into a Hazel workspace via OAuth — pick destinations per notification.",
		icon: HazelIcon,
		accent: HAZEL_ACCENT,
	},
	{
		id: "github",
		name: "GitHub",
		description: "Install the Maple GitHub App to sync repositories and commits from your org.",
		icon: GithubIcon,
		accent: GITHUB_ACCENT,
		docsUrl: "https://maple.dev/docs/integrations/github",
	},
]

export const catalogEntry = (id: IntegrationId): CatalogEntry => CATALOG.find((entry) => entry.id === id)!

interface CardStatus {
	readonly label: string
	readonly variant: "success" | "warning" | "error" | "outline"
}

const NOT_CONNECTED: CardStatus = { label: "Not connected", variant: "outline" }

/**
 * Per-integration status derived purely from the list queries the drill-ins
 * already use — no per-target check fan-out at catalog level.
 */
export function useIntegrationStatuses(): Partial<Record<IntegrationId, CardStatus | null>> {
	const cloudflareResult = useAtomValue(MapleApiAtomClient.query("cloudflareLogpush", "list", {}))
	const scrapeResult = useAtomValue(MapleApiAtomClient.query("scrapeTargets", "list", {}))
	const hazelResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "hazelStatus", {
			reactivityKeys: ["hazelIntegrationStatus"],
		}),
	)
	const githubResult = useAtomValue(
		MapleApiAtomClient.query("integrations", "githubStatus", {
			reactivityKeys: ["githubIntegrationStatus"],
		}),
	)

	const cloudflare: CardStatus | null = Result.builder(cloudflareResult)
		.onSuccess((response): CardStatus => {
			const connectors = response.connectors
			if (connectors.length === 0) return NOT_CONNECTED
			const enabled = connectors.filter((connector) => connector.enabled).length
			const failing = connectors.some((connector) => connector.lastError)
			return {
				label: `${connectors.length} connector${connectors.length === 1 ? "" : "s"} · ${enabled} enabled`,
				variant: failing ? "warning" : "success",
			}
		})
		.orElse(() => (Result.isInitial(cloudflareResult) ? null : NOT_CONNECTED))

	const scrapeStatus = (targetType: "prometheus" | "planetscale"): CardStatus | null =>
		Result.builder(scrapeResult)
			.onSuccess((response): CardStatus => {
				const targets = response.targets.filter((target) => target.targetType === targetType)
				if (targets.length === 0) return NOT_CONNECTED
				const failing = targets.some((target) => target.enabled && target.lastScrapeError)
				const enabled = targets.filter((target) => target.enabled).length
				const noun = targetType === "planetscale" ? "org" : "target"
				return {
					label: `${targets.length} ${noun}${targets.length === 1 ? "" : "s"} · ${enabled} enabled`,
					variant: failing ? "warning" : "success",
				}
			})
			.orElse(() => (Result.isInitial(scrapeResult) ? null : NOT_CONNECTED))

	const hazel: CardStatus | null = Result.builder(hazelResult)
		.onSuccess(
			(status): CardStatus =>
				status.connected ? { label: "Connected", variant: "success" } : NOT_CONNECTED,
		)
		.orElse(() => (Result.isInitial(hazelResult) ? null : NOT_CONNECTED))

	const github: CardStatus | null = Result.builder(githubResult)
		.onSuccess((status): CardStatus => {
			if (!status.connected) return NOT_CONNECTED
			// Count only active repos; provider-removed ones are shown in the card
			// with a re-enable/delete affordance, not as live synced repos.
			const count = status.repositories.filter((r) => r.status === "active").length
			return {
				label: count > 0 ? `${count} repo${count === 1 ? "" : "s"}` : "Connected",
				variant: "success",
			}
		})
		.orElse(() => (Result.isInitial(githubResult) ? null : NOT_CONNECTED))

	return {
		cloudflare,
		prometheus: scrapeStatus("prometheus"),
		planetscale: scrapeStatus("planetscale"),
		// WarpStream rides the generic Prometheus pipeline — no own target type.
		warpstream: { label: "Via Prometheus", variant: "outline" },
		hazel,
		github,
	}
}

const GRID_VARIANTS = {
	hidden: {},
	show: {
		transition: { staggerChildren: 0.05, delayChildren: 0.05 },
	},
}

const ITEM_VARIANTS = {
	hidden: { opacity: 0, y: 6 },
	show: {
		opacity: 1,
		y: 0,
		transition: { duration: 0.32, ease: [0.16, 1, 0.3, 1] as const },
	},
}

export function IntegrationIconPlate({
	entry,
	size = 22,
	className,
}: {
	entry: CatalogEntry
	size?: number
	className?: string
}) {
	const Icon = entry.icon
	return (
		<span
			className={`relative inline-flex size-12 shrink-0 items-center justify-center rounded-lg border border-border/60 bg-card ${className ?? ""}`}
			style={{ ["--tile-accent" as string]: entry.accent }}
			aria-hidden
		>
			<span
				className="absolute inset-0 rounded-lg opacity-70"
				style={{
					background: `radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--tile-accent) 16%, transparent), transparent 70%)`,
				}}
			/>
			<span className="relative" style={{ color: entry.accent }}>
				<Icon size={size} />
			</span>
		</span>
	)
}

export function IntegrationCatalog({ onSelect }: { onSelect: (id: IntegrationId) => void }) {
	const statuses = useIntegrationStatuses()

	return (
		<motion.div
			className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3"
			variants={GRID_VARIANTS}
			initial="hidden"
			animate="show"
		>
			{CATALOG.map((entry) => {
				const status = statuses[entry.id]
				return (
					<motion.button
						key={entry.id}
						type="button"
						variants={ITEM_VARIANTS}
						onClick={() => onSelect(entry.id)}
						className="group flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4 text-left outline-none transition-colors hover:border-border hover:bg-muted/40 focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
					>
						<IntegrationIconPlate entry={entry} />
						<span className="flex min-w-0 flex-1 flex-col gap-1">
							<span className="flex items-center justify-between gap-2">
								<span className="truncate text-sm font-semibold">{entry.name}</span>
								{status === null || status === undefined ? (
									<Skeleton className="h-5 w-20 shrink-0 rounded-full" />
								) : (
									<Badge variant={status.variant} className="shrink-0">
										{status.label}
									</Badge>
								)}
							</span>
							<span className="text-xs text-muted-foreground">{entry.description}</span>
						</span>
					</motion.button>
				)
			})}
		</motion.div>
	)
}
