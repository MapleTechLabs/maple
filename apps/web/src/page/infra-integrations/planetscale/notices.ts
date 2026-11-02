import type { V2PlanetScaleIntegration } from "@maple/domain/http/v2"
import {
	type LiveCheck,
	metricsAuthOf,
	metricsLastError,
} from "../../../components/integrations/planetscale-setup-steps"
import { toEpochMs } from "@maple/ui/lib/time-format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { alert, alertAction, alertDescription, alertTitle } from "../../../ui/alert"
import { linkButton } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import {
	integrationConnectCta,
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyFooter,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../kit/integration-empty"
import { liveChecklist } from "../../kit/connect-flow"
import { relativeTime } from "../../kit/relative-time"

// PlanetScale absence notices and the setup state.

export const PLANETSCALE_COLOR = "oklch(0.62 0.02 270)"
export const BRANCH_ABSENCE_COPY = {
	excluded: "Excluded from metrics collection by this connection's branch filters.",
	"no-data": "No metrics for this branch in this window",
} as const

const INTEGRATION_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "planetscale" } }))

/** `PlanetScaleMetricsNotice`: metrics arrived before and have stopped. */
export const metricsNotice = <M>(h: HtmlBuilder<M>, status: V2PlanetScaleIntegration): Html => {
	const error = metricsLastError(status)
	const source = metricsAuthOf(status) === "api" ? "poll" : "scrape"
	return alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, ["Branch metrics stopped arriving"]),
		alertDescription(h, [
			"Databases and branches are up to date, and query insights still work. Connections, CPU, memory, storage, and replica lag are not updating.",
			...(error === null ? [] : [` The last ${source} failed: ${error}`]),
		]),
		alertAction(h, [
			linkButton(h, { size: "sm", variant: "outline", href: INTEGRATION_HREF }, ["View integration"]),
		]),
	])
}

export const revokedNotice = <M>(h: HtmlBuilder<M>): Html =>
	alert(h, { variant: "crit" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["PlanetScale authorization revoked"]),
		alertDescription(h, [
			"Maple can no longer read this organization, so databases, branches, and metrics are frozen at their last known state. Reconnecting restores them.",
		]),
		alertAction(h, [linkButton(h, { size: "sm", href: INTEGRATION_HREF }, ["Reconnect PlanetScale"])]),
	])

export const inventoryNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		lastInventoryAt: string | null
		lastInventoryError: string | null
		nowMs: number
		timeZone: string
	}>,
): Html => {
	const failing = options.lastInventoryError !== null
	return alert(h, { variant: "warn" }, [
		icon(h, "AlertWarningIcon"),
		alertTitle(h, [failing ? "Inventory refresh is failing" : "Inventory hasn't refreshed recently"]),
		alertDescription(
			h,
			failing
				? ["The database and branch list may be out of date. Metrics are unaffected."]
				: [
						"The database and branch list may be out of date. Last refreshed",
						" ",
						options.lastInventoryAt === null
							? "never"
							: relativeTime(h, {
									tooltip: "title",
									value: options.lastInventoryAt,
									nowMs: options.nowMs,
									timeZone: options.timeZone,
								}),
						".",
					],
		),
	])
}

const INVENTORY_STALE_MS = 90 * 60 * 1000

export const inventoryIsStale = (lastInventoryAt: string | null, nowMs: number): boolean =>
	lastInventoryAt !== null && nowMs - toEpochMs(lastInventoryAt) > INVENTORY_STALE_MS

const BRAND = { icon: "PlanetScaleIcon", accent: PLANETSCALE_COLOR } as const

/** `PlanetScaleSetupState`: metrics have never arrived for this connection. */
export const setupState = <M>(h: HtmlBuilder<M>, checks: ReadonlyArray<LiveCheck>): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Utilization",
				title: "CPU, memory, connections",
				description: "Per branch, collected from PlanetScale every 5 minutes.",
			},
			{
				label: "Storage",
				title: "Disk headroom over time",
				description: "The slow-moving number nothing else in Maple reveals.",
			},
			{
				label: "Replication",
				title: "Replica lag per branch",
				description: "Catch a replica falling behind before your reads go stale.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, BRAND),
			integrationEmptyHint(h, [
				"Branch metrics start arriving within minutes of connecting. Maple collects them on your PlanetScale authorization.",
			]),
			h.div(
				[h.Class("w-full max-w-md text-left")],
				[liveChecklist(h, { title: "Checking the connection", rows: checks })],
			),
			linkButton(h, { href: INTEGRATION_HREF }, ["View integration"]),
			integrationEmptyFooter(h, ["Nothing to install · your databases below are already live."]),
		]),
	])

/** Nothing connected: what the page will show, and the way into the connect flow. */
export const planetscaleConnectCta = <M>(h: HtmlBuilder<M>): Html =>
	integrationConnectCta(h, {
		brand: BRAND,
		features: [
			{
				label: "Utilization",
				title: "CPU, memory, connections",
				description: "Per branch, collected from PlanetScale every 5 minutes.",
			},
			{
				label: "Storage",
				title: "Disk headroom over time",
				description: "The slow-moving number nothing else in Maple reveals.",
			},
			{
				label: "Replication",
				title: "Replica lag per branch",
				description: "Catch a replica falling behind before your reads go stale.",
			},
		],
		hint: "Authorize your PlanetScale organization and Maple tracks every branch's health, with nothing to install.",
		label: "Connect PlanetScale",
		href: INTEGRATION_HREF,
	})
