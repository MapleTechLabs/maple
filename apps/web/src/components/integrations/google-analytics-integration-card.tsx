import { useState } from "react"
import { Exit } from "effect"
import { Badge } from "@maple/ui/components/ui/badge"
import { Button } from "@maple/ui/components/ui/button"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { Switch } from "@maple/ui/components/ui/switch"
import { toastManager } from "@maple/ui/components/ui/toast"

import { GoogleAnalyticsIcon, LoaderIcon } from "@/components/icons"
import { formatRelativeTime } from "@maple/ui/lib/time-format"
import { Result, useAtomRefresh, useAtomSet, useAtomValue } from "@/lib/effect-atom"
import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"
import { showErrorToast } from "@/lib/error-toast"
import { IntegrationIconPlate, catalogEntry } from "./integration-catalog"
import { useIntegrationConnect } from "./integration-connect"
import {
	IntegrationEmpty,
	IntegrationEmptyCard,
	IntegrationEmptyFeature,
	IntegrationEmptyFeatures,
	IntegrationEmptyHint,
	IntegrationEmptyMedia,
} from "./integration-empty-state"

const GA_ENTRY = catalogEntry("google-analytics")

/**
 * Google Analytics 4 connection card: authorize a Google account in a popup, and every GA4
 * property that account can see is discovered and collected automatically. Per-property toggles
 * are the one knob — an agency account reaching hundreds of properties should not have to collect
 * all of them.
 *
 * Disconnect lives in the card body rather than the route header, matching PlanetScale and Slack;
 * Cloudflare's header actions are the outlier.
 */
export function GoogleAnalyticsIntegrationCard() {
	const statusQuery = retainedQueryV2("googleAnalyticsIntegration", "status", {
		reactivityKeys: ["googleAnalyticsIntegration"],
	})
	const statusResult = useAtomValue(statusQuery)
	const refreshStatus = useAtomRefresh(statusQuery)

	const connectFlow = useIntegrationConnect()
	if (connectFlow === null) {
		throw new Error("GoogleAnalyticsIntegrationCard must render inside IntegrationConnectProvider")
	}

	const disconnect = useAtomSet(
		MapleApiV2AtomClient.mutation("googleAnalyticsIntegration", "disconnect"),
		{ mode: "promiseExit" },
	)
	const updateProperty = useAtomSet(
		MapleApiV2AtomClient.mutation("googleAnalyticsIntegration", "updateProperty"),
		{ mode: "promiseExit" },
	)

	const handleDisconnect = async () => {
		const result = await disconnect({ reactivityKeys: ["googleAnalyticsIntegration"] })
		if (Exit.isSuccess(result)) {
			toastManager.add({ title: "Google Analytics disconnected", type: "success" })
			refreshStatus()
		} else {
			showErrorToast(result, { fallbackTitle: "Failed to disconnect Google Analytics" })
		}
	}

	// Which property's toggle is in flight. The mutation atom is shared across every row, so a
	// second toggle cancels the first one's client-side effect without cancelling the PATCH that
	// already reached the API — and `setPropertyEnabled` is an unconditional write with no ordering
	// check, so the older request could land last and undo the user's final choice. Disabling the
	// row that is pending is what keeps the two in order.
	const [pendingProperty, setPendingProperty] = useState<string | null>(null)

	const handleToggle = async (propertyId: string, enabled: boolean) => {
		setPendingProperty(propertyId)
		const result = await updateProperty({
			params: { property_id: propertyId },
			payload: { enabled },
			reactivityKeys: ["googleAnalyticsIntegration"],
		})
		setPendingProperty(null)
		if (Exit.isSuccess(result)) {
			refreshStatus()
		} else {
			showErrorToast(result, { fallbackTitle: "Failed to update the property" })
		}
	}

	if (Result.isInitial(statusResult)) {
		return <Skeleton className="h-40 w-full rounded-lg" />
	}

	// A failed status fetch is not "not connected" — don't offer the connect CTA over an
	// account that may already be authorized.
	if (Result.isFailure(statusResult)) {
		return (
			<div className="flex items-start gap-4 rounded-lg border border-border/60 bg-card p-4">
				<IntegrationIconPlate icon={GoogleAnalyticsIcon} accent={GA_ENTRY.accent} />
				<div className="flex flex-col gap-1">
					<h3 className="text-sm font-semibold">Google Analytics</h3>
					<p className="text-xs text-muted-foreground">
						Couldn&apos;t load the Google Analytics connection status — refresh the page to try
						again.
					</p>
				</div>
			</div>
		)
	}

	const status = statusResult.value

	if (!status.connected) {
		return (
			<IntegrationEmpty icon={GoogleAnalyticsIcon} accent={GA_ENTRY.accent}>
				<IntegrationEmptyFeatures>
					<IntegrationEmptyFeature
						label="Dashboards"
						title="Sessions next to traces"
						description="GA4 numbers land as regular metrics, so they chart beside your own telemetry."
					/>
					<IntegrationEmptyFeature
						label="Breakdowns"
						title="Channel, page, country, device"
						description="The slices you actually look at, collected hourly for every property."
					/>
					<IntegrationEmptyFeature
						label="Alerts"
						title="Alert on traffic"
						description="Anything you can chart, you can alert on — no separate rule system."
					/>
				</IntegrationEmptyFeatures>
				<IntegrationEmptyCard>
					<IntegrationEmptyMedia />
					<IntegrationEmptyHint>
						Every GA4 property the Google account can see appears here after connecting.
					</IntegrationEmptyHint>
					<Button onClick={connectFlow.connect} disabled={connectFlow.busy}>
						{connectFlow.busy ? (
							<LoaderIcon size={16} className="animate-spin" />
						) : (
							<GoogleAnalyticsIcon size={16} />
						)}
						Connect Google Analytics
					</Button>
				</IntegrationEmptyCard>
			</IntegrationEmpty>
		)
	}

	return (
		<div className="overflow-hidden rounded-lg border border-border/60 bg-card">
			<div className="flex items-start justify-between gap-3 p-4">
				<div className="flex items-start gap-3">
					<IntegrationIconPlate icon={GoogleAnalyticsIcon} accent={GA_ENTRY.accent} />
					<div className="min-w-0">
						<div className="flex items-center gap-2">
							<h3 className="text-sm font-semibold">Google Analytics</h3>
							{status.revoked ? (
								<Badge variant="warning">Reconnect needed</Badge>
							) : (
								<Badge variant="secondary">Connected</Badge>
							)}
						</div>
						<p className="mt-1 truncate text-xs text-muted-foreground">
							{status.connected_email ?? "Connected Google account"}
						</p>
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{status.revoked && (
						<Button variant="outline" size="sm" onClick={connectFlow.connect} disabled={connectFlow.busy}>
							{connectFlow.busy && <LoaderIcon size={14} className="animate-spin" />}
							Reconnect
						</Button>
					)}
					<Button variant="ghost" size="sm" onClick={handleDisconnect}>
						Disconnect
					</Button>
				</div>
			</div>

			{status.revoked && (
				<p className="border-t border-border/60 bg-warning/5 px-4 py-3 text-xs text-muted-foreground">
					Google rejected the stored authorization, so collection has stopped. Everything already
					collected is still here — reconnect to resume.
				</p>
			)}

			<div className="border-t border-border/60">
				{status.properties.length === 0 ? (
					<p className="p-4 text-xs text-muted-foreground">
						No GA4 properties discovered yet. Discovery runs hourly after connecting.
					</p>
				) : (
					<ul className="divide-y divide-border/60">
						{status.properties.map((property) => (
							<li key={property.property_id} className="flex items-center justify-between gap-3 p-4">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="truncate text-sm font-medium">
											{property.property_name ?? property.property_id}
										</span>
										<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
											{property.property_id}
										</span>
									</div>
									<p className="mt-0.5 truncate text-xs text-muted-foreground">
										{propertyDetail(property)}
									</p>
								</div>
								<Switch
									checked={property.enabled}
									disabled={pendingProperty === property.property_id}
									onCheckedChange={(checked) => void handleToggle(property.property_id, checked)}
									aria-label={`Collect ${property.property_name ?? property.property_id}`}
								/>
							</li>
						))}
					</ul>
				)}
			</div>
		</div>
	)
}

type PropertyStatus = {
	readonly enabled: boolean
	readonly account_name: string | null
	readonly time_zone: string | null
	readonly last_error: string | null
	readonly last_synced_at: string | null
}

/** The one line under a property's name: whatever most needs saying about it. */
function propertyDetail(property: PropertyStatus): string {
	if (!property.enabled) return "Not collected"
	if (property.last_error !== null) return property.last_error
	// No timezone means the property has never been collected — GA4 reports hourly data in the
	// property's own zone, so nothing can be placed on the timeline until it resolves.
	if (property.time_zone === null) return "Waiting for the first collection"
	const account = property.account_name ?? "Google Analytics"
	return property.last_synced_at === null
		? account
		: `${account} · synced ${formatRelativeTime(property.last_synced_at)}`
}
