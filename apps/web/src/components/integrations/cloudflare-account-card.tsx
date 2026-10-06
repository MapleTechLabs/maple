import { useMemo } from "react"
import { countLabel } from "@maple/ui/lib/format"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@maple/ui/components/ui/alert"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Item, ItemActions, ItemContent, ItemMedia } from "@maple/ui/components/ui/item"
import { Panel, PanelHeader } from "@maple/ui/components/ui/panel"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

import { CircleWarningIcon, CloudflareIcon, CloudflareMonoIcon } from "@/components/icons"
import { ErrorState } from "@/components/common/error-state"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiAtomClient, retainedQuery } from "@/lib/services/common/atom-client"
import { CLOUDFLARE_ACCENT } from "./integration-catalog"
import { useRequiredIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyFooter,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"
import { CloudflareStatCards } from "./cloudflare-stat-cards"
import { useIntegrationDisconnect } from "./use-integration-disconnect"
import { CloudflareIngestBanner } from "@/components/infra/cloudflare/cloudflare-ingest-status"
import { useCloudflareIngestPhase } from "@/components/infra/cloudflare/use-cloudflare-ingest-phase"
import {
	CloudflareWorkersCard,
	CloudflareZoneBoard,
	describeCloudflareError,
	isAccountScoped,
	toRowUsage,
	type CloudflareErrorInfo,
	type RowUsage,
	type ZoneEntry,
} from "./cloudflare-zone-board"

const EMPTY_USAGE: RowUsage = { totalRequests: 0, lastDataAt: null, points: [] }

/** The slice of a connected account the strip renders (schema class or legacy fallback). */
interface ConnectedAccountEntry {
	readonly accountId: string
	readonly accountName: string | null
	readonly analyticsCapable: boolean
	readonly revoked: boolean
	readonly zoneCount: number
}

/**
 * The accounts the org's grant covers, one row per account with its health badges. One OAuth
 * grant carries every account, so there is no per-account disconnect — changing the set means
 * reconnecting and ticking different accounts on Cloudflare's consent screen.
 */
function CloudflareAccountsStrip({ accounts }: { readonly accounts: ReadonlyArray<ConnectedAccountEntry> }) {
	if (accounts.length < 2) return null
	return (
		<Panel className="rounded-lg border-border/60">
			<PanelHeader title={`Connected accounts (${accounts.length})`} className="border-border/60" />
			<ul className="divide-y divide-border/60">
				{accounts.map((account) => (
					<Item
						key={account.accountId}
						variant="flush"
						size="lg"
						className="py-2.5"
						render={<li />}
					>
						<ItemMedia>
							<CloudflareMonoIcon size={16} className="text-muted-foreground" />
						</ItemMedia>
						<ItemContent className="gap-0">
							<span className="truncate text-sm font-medium">
								{account.accountName ?? account.accountId}
							</span>
							<span className="truncate font-mono text-2xs text-muted-foreground">
								{account.accountId}
							</span>
						</ItemContent>
						<ItemActions className="gap-1.5">
							{account.revoked ? (
								<Badge variant="crit">Reconnect required</Badge>
							) : !account.analyticsCapable ? (
								<Badge variant="warn">Needs updated access</Badge>
							) : null}
							<span className="text-xs text-muted-foreground">
								{countLabel(account.zoneCount, "zone")}
							</span>
						</ItemActions>
					</Item>
				))}
			</ul>
		</Panel>
	)
}

/**
 * Account-level Cloudflare OAuth connection (Authorization Code + PKCE). Distinct from the
 * Logpush connectors below it on the page: this authorizes Maple against the customer's
 * Cloudflare account so later phases can auto-provision telemetry (Workers traces/logs,
 * Logpush jobs) instead of the manual copy-paste setup.
 */
export function CloudflareAccountCard() {
	// Status plus the warehouse-derived ingest volume (which loads independently, so the card
	// renders instantly from status and the usage columns hydrate afterwards) — and the ingest
	// phase they imply, which also drives the polling that fills a fresh connection in place.
	const { statusResult, usageResult, phase } = useCloudflareIngestPhase()
	const refreshStatus = useAtomRefresh(
		retainedQuery("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)

	// Connect flow (popup, busy, refresh-on-return) lives in IntegrationConnectProvider —
	// shared with the drill-in header's Connect/Reconnect/Disconnect buttons.
	const connectFlow = useRequiredIntegrationConnect("CloudflareAccountCard")
	const actionBusy = connectFlow.busy

	const status = Result.builder(statusResult)
		.onSuccess((s) => s)
		.orElse(() => null)

	// A failed usage fetch degrades to the poller-only view — never an error box
	// over what is decoration on top of the status readout.
	const usage = Result.builder(usageResult)
		.onSuccess((u) => u)
		.orElse(() => null)
	const usageLoaded = usage != null
	// Failure ≠ still-loading: the stat band hides entirely instead of skeleton-ing forever.
	const usageFailed = Result.isFailure(usageResult)

	const workerServices = useMemo(
		() => (usage ? usage.services.filter((service) => service.kind === "worker") : []),
		[usage],
	)
	const workersRowUsage = usage && workerServices.length > 0 ? toRowUsage(usage, workerServices) : null

	const zoneUsage = (zoneName: string): RowUsage | null => {
		if (!usage) return null
		const service = usage.services.find((s) => s.kind === "zone" && s.displayName === zoneName)
		return service ? toRowUsage(usage, [service]) : { ...EMPTY_USAGE }
	}

	// Zones the warehouse has data for but the poller has no state row yet (discovery
	// lag, or data arriving via Logpush) — still proof the integration works, so list them.
	const unmatchedZoneServices = useMemo(() => {
		if (!usage || !status) return []
		const known = new Set(status.zones.map((zone) => zone.name))
		return usage.services.filter((service) => service.kind === "zone" && !known.has(service.displayName))
	}, [usage, status])

	// Connected accounts for the strip. Older API responses predate `accounts`; synthesize
	// the single-connection entry from the legacy top-level fields during a deploy window.
	const connectedAccounts = useMemo((): ReadonlyArray<ConnectedAccountEntry> => {
		if (status?.connected !== true) return []
		const list = status.accounts ?? []
		if (list.length > 0) {
			return list.map((account) => ({
				accountId: account.accountId,
				accountName: account.accountName,
				analyticsCapable: account.analyticsCapable,
				revoked: account.revoked,
				zoneCount: account.zones.length,
			}))
		}
		return status.accountId == null
			? []
			: [
					{
						accountId: status.accountId,
						accountName: status.accountName,
						analyticsCapable: status.analyticsCapable,
						revoked: false,
						zoneCount: status.zones.length,
					},
				]
	}, [status])

	// The first account-wide failure across zones/workers (revoked token, missing config, denied
	// auth). Surfaced once as a banner instead of repeated — and unreadable — on every row.
	const accountError = useMemo((): (CloudflareErrorInfo & { raw: string }) | null => {
		if (!status) return null
		const raws = [status.workers?.lastError ?? null, ...status.zones.map((z) => z.lastError)]
		for (const raw of raws) {
			if (raw && isAccountScoped(raw)) return { ...describeCloudflareError(raw), raw }
		}
		return null
	}, [status])

	// One renderable entry per zone (poller state joined with warehouse usage). The board owns
	// searching, status filtering, sorting, and the bounded scroll — this just assembles the set.
	const zoneEntries: Array<ZoneEntry> = (status?.zones ?? []).map((zone) => ({
		key: zone.id,
		name: zone.name,
		enabled: zone.enabled,
		lastSyncedAt: zone.lastSyncedAt,
		lastError: zone.lastError,
		usage: zoneUsage(zone.name),
	}))
	for (const service of unmatchedZoneServices) {
		zoneEntries.push({
			key: service.serviceName,
			name: service.displayName,
			enabled: true,
			lastSyncedAt: null,
			lastError: null,
			usage: usage ? toRowUsage(usage, [service]) : null,
		})
	}

	const isConnected = status?.connected === true

	const connectButton = (label: string, variant?: "outline") => (
		<Button
			size="sm"
			onClick={connectFlow.connect}
			disabled={actionBusy}
			loading={connectFlow.busy}
			variant={variant}
		>
			{label}
		</Button>
	)

	// Guard the first fetch so a connected org doesn't flash the "Connect" empty state.
	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}

	// A failed status fetch is not "not connected" — don't offer the connect CTA
	// over an account that may already be authorized.
	if (Result.isFailure(statusResult)) {
		return (
			<ErrorState
				error={statusResult.cause}
				title="Failed to load the Cloudflare integration"
				onRetry={refreshStatus}
			/>
		)
	}

	if (!isConnected) {
		return (
			<IntegrationEmpty
				icon={CloudflareIcon}
				backerIcon={CloudflareMonoIcon}
				accent={CLOUDFLARE_ACCENT}
			>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Zone analytics"
						title="Requests & cache per zone"
						description="Traffic, cache hit rate, and errors for every zone under Infrastructure."
					/>
					<IntegrationEmptyFeature
						label="Workers"
						title="Scripts on the service map"
						description="Every Worker appears as a node with request volume and errors wired into traces."
					/>
					<IntegrationEmptyFeature
						label="DNS & security"
						title="Firewall events with context"
						description="DNS records, hosts, and WAF activity land alongside your traces and logs."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Your zones and Workers will appear here after connecting.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={actionBusy} loading={connectFlow.busy}>
						<CloudflareIcon size={16} />
						Connect Cloudflare
					</Button>
					<IntegrationEmptyFooter>
						Read-only OAuth · takes about a minute · disconnect anytime
					</IntegrationEmptyFooter>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	const hasReadout =
		status != null &&
		(status.zones.length > 0 || status.workers != null || (usage != null && usage.services.length > 0))
	const zoneCount = zoneEntries.length
	const hasWorkers = status?.workers != null || workerServices.length > 0

	// Aggregate Workers state in the zone-entry shape so the side card's problem line
	// derives from the same `zoneStatus` rules as zone rows.
	const workerEntry: ZoneEntry = {
		key: "workers",
		name: "Workers",
		enabled: status?.workers?.enabled ?? true,
		lastSyncedAt: status?.workers?.lastSyncedAt ?? null,
		lastError: status?.workers?.lastError ?? null,
		usage: usage ? (workersRowUsage ?? { ...EMPTY_USAGE }) : null,
	}

	// One banner for the whole-account problem — the actionable "what's wrong + how to
	// fix". Lives inside the Zones card (the resources it pauses); standalone when there
	// are no zones to attach it to.
	const banner =
		status == null ? null : !status.analyticsCapable ? (
			<Alert variant="warn">
				<CircleWarningIcon />
				<AlertTitle>Update access to collect analytics</AlertTitle>
				<AlertDescription>
					Maple needs updated Cloudflare permissions to read traffic analytics from this account.
				</AlertDescription>
				<AlertAction>{connectButton("Update access")}</AlertAction>
			</Alert>
		) : accountError ? (
			<Alert variant={accountError.tone}>
				<CircleWarningIcon />
				<AlertTitle>Traffic collection paused</AlertTitle>
				<AlertDescription>
					<span>{accountError.summary}</span>
					{accountError.summary !== accountError.raw ? (
						<Tooltip>
							<TooltipTrigger
								render={<span />}
								className="w-fit cursor-help text-xs font-medium text-muted-foreground underline decoration-dotted underline-offset-2"
							>
								Error details
							</TooltipTrigger>
							<TooltipContent className="max-w-xs whitespace-pre-wrap break-words font-mono text-2xs">
								{accountError.raw}
							</TooltipContent>
						</Tooltip>
					) : null}
				</AlertDescription>
				<AlertAction>{connectButton("Reconnect", "outline")}</AlertAction>
			</Alert>
		) : null

	return (
		<div className="flex flex-col gap-4">
			<CloudflareAccountsStrip accounts={connectedAccounts} />
			{/* A broken grant or a paused account outranks "still collecting" — never stack both. */}
			{banner == null && phase != null ? <CloudflareIngestBanner phase={phase} /> : null}
			{hasReadout ? (
				<>
					{!usageFailed ? (
						<CloudflareStatCards usage={usage} workerServices={workerServices} />
					) : null}
					{zoneCount === 0 && banner}
					<div className="flex flex-col gap-4 lg:flex-row lg:items-start">
						{zoneCount > 0 ? (
							<CloudflareZoneBoard
								zones={zoneEntries}
								usageLoaded={usageLoaded}
								banner={banner}
								className="min-w-0 flex-1"
							/>
						) : null}
						{hasWorkers ? (
							<CloudflareWorkersCard
								workerEntry={workerEntry}
								workerServices={workerServices}
								usageLoaded={usageLoaded}
								className="lg:w-72 lg:shrink-0 xl:w-80"
							/>
						) : null}
					</div>
				</>
			) : (
				// Nothing discovered yet. The phase banner above already says what is happening and
				// when to expect data; this only has to keep the card from looking finished.
				<>
					{banner}
					{banner != null || phase == null ? (
						<p className="text-xs text-muted-foreground">
							Your zones and Workers will appear here once collection starts.
						</p>
					) : null}
				</>
			)}
		</div>
	)
}

/**
 * Reconnect + Disconnect for the drill-in page header — rendered by the route when the
 * integration is connected, replacing the account card's old header band. Must live
 * inside IntegrationConnectProvider (same popup flow as Connect).
 */
export function CloudflareHeaderActions() {
	const connectFlow = useRequiredIntegrationConnect("CloudflareHeaderActions")
	const disconnect = useAtomSet(MapleApiAtomClient.mutation("integrations", "cloudflareDisconnect"), {
		mode: "promiseExit",
	})
	// Same memoized atom as the card — no extra fetch, just the account count for labels.
	const statusResult = useAtomValue(
		retainedQuery("integrations", "cloudflareStatus", {
			reactivityKeys: ["cloudflareIntegrationStatus"],
		}),
	)
	const accountCount = Result.builder(statusResult)
		.onSuccess((s) => s.accounts?.length ?? (s.connected ? 1 : 0))
		.orElse(() => 1)
	const multiAccount = accountCount > 1
	const { disconnect: handleDisconnect, pending: disconnectBusy } = useIntegrationDisconnect(
		() => disconnect({ reactivityKeys: ["cloudflareIntegrationStatus", "cloudflareIntegrationUsage"] }),
		{
			success: multiAccount ? "Cloudflare accounts disconnected" : "Cloudflare account disconnected",
			error: "Failed to disconnect Cloudflare",
		},
	)
	const actionBusy = connectFlow.busy || disconnectBusy

	return (
		<div className="flex items-center gap-2">
			<Button
				size="sm"
				variant="outline"
				onClick={connectFlow.connect}
				disabled={actionBusy}
				loading={connectFlow.busy}
			>
				{multiAccount ? "Edit accounts" : "Reconnect"}
			</Button>
			<Button
				size="sm"
				variant="destructive-outline"
				onClick={handleDisconnect}
				disabled={actionBusy}
				loading={disconnectBusy}
			>
				{multiAccount ? "Disconnect all" : "Disconnect"}
			</Button>
		</div>
	)
}
