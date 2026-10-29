import type { CloudflareIntegrationStatus, CloudflareUsageResponse } from "@maple/domain/http"
import { countLabel, formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	type CloudflareIngestPhase,
	describeCloudflareIngestPhase,
	FIRST_DATA_MINUTES,
} from "../../components/infra/cloudflare/ingest-phase"
import { alert, alertAction, alertDescription, alertTitle } from "../../ui/alert"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { meter } from "../../ui/meter"
import { truncatedText } from "../../ui/truncated-text"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { catalogEntry } from "./catalog"
import {
	accountErrorOf,
	type ConnectedAccountEntry,
	connectedAccountsOf,
	workerServicesOf,
} from "./cloudflare-derive"
import type { FlowStage } from "./flow"
import { cloudflarePhaseOf, cloudflareReach, cloudflareStatusOf, cloudflareUsageOf } from "./flow-cloudflare"
import { Message } from "./message"
import type { Model } from "./model"

// Cloudflare in the connect flow: approve Maple on Cloudflare's consent screen, then watch the
// poller find zones and Workers and fill in the first data.

type H = HtmlBuilder<Message>

const DOCS_HREF = catalogEntry("cloudflare").docsUrl

const readsRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{
				icon: "ChartBarIcon",
				title: "Zone analytics",
				detail: "Requests, cache hit rate and errors per zone",
			},
			{
				icon: "BracketsCurlyIcon",
				title: "Workers",
				detail: "Invocations, errors and CPU time, on the service map",
			},
			{ icon: "ShieldIcon", title: "DNS and firewall", detail: "DNS queries, WAF and firewall events" },
		],
		trust: "Read-only. No agents or Logpush setup. Maple never changes DNS, rules or Workers. Revoke any time in Cloudflare under My Profile, API Tokens.",
		timeNote: "Takes about 1 minute",
		docs: DOCS_HREF === undefined ? null : { label: "Setup docs", href: DOCS_HREF },
	})

const showsUpRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ServerIcon",
				title: "Infrastructure, Cloudflare",
				detail: "One row per zone and Worker",
			},
			{
				icon: "NetworkNodesIcon",
				title: "Service map",
				detail: "Workers appear as nodes once they serve traffic",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Reconnect, Disconnect" },
		],
		trust: "Nothing to apply in Cloudflare. Maple reads through the OAuth grant; no Logpush jobs, Workers or rules are created.",
		timeNote: `First data within ${FIRST_DATA_MINUTES} minutes`,
		docs: DOCS_HREF === undefined ? null : { label: "Docs", href: DOCS_HREF },
	})

const connectButton = (h: H, model: Model, label: string, variant?: "outline"): Html =>
	button(
		h,
		{
			size: variant === undefined ? undefined : "sm",
			variant,
			className: "w-fit",
			isDisabled: model.connect.isStarting,
			isLoading: model.connect.isStarting,
			attributes: [h.OnClick(Message.ClickedConnect())],
		},
		variant === undefined ? [icon(h, "CloudflareBrandIcon"), label] : [label],
	)

const accountList = (h: H, accounts: ReadonlyArray<ConnectedAccountEntry>): Html =>
	h.ul(
		[h.Class("flex flex-col rounded-md border border-border"), h.AriaLabel("Cloudflare accounts")],
		accounts.map((account) =>
			h.li(
				[h.Class("flex items-center gap-3 border-t border-border/60 px-3.5 py-2.5 first:border-t-0")],
				[
					icon(h, account.revoked ? "CircleWarningIcon" : "CircleCheckIcon", {
						size: 14,
						className: account.revoked ? "shrink-0 text-severity-error" : "shrink-0 text-success",
					}),
					h.div(
						[h.Class("flex min-w-0 flex-1 flex-col")],
						[
							truncatedText(h, {
								text: account.accountName ?? account.accountId,
								className: "text-sm",
							}),
							h.span(
								[h.Class("text-xs text-muted-foreground")],
								[
									account.revoked
										? "Access revoked"
										: account.analyticsCapable
											? countLabel(account.zoneCount, "zone")
											: `${countLabel(account.zoneCount, "zone")}, analytics access missing`,
								],
							),
						],
					),
					truncatedText(h, {
						text: account.accountId,
						mono: true,
						className: "max-w-32 text-2xs text-muted-foreground",
					}),
				],
			),
		),
	)

/** "2 accounts, 12 zones and 7 Workers": Workers come from the usage read once it lands. */
const foundLine = (status: CloudflareIntegrationStatus, usage: CloudflareUsageResponse | null): string => {
	const accounts = Math.max(connectedAccountsOf(status).length, 1)
	const workers = workerServicesOf(usage).length
	const parts = [
		countLabel(accounts, "account"),
		countLabel(status.zones.length, "zone"),
		...(workers > 0 ? [countLabel(workers, "Worker")] : []),
	]
	return parts.length === 3 ? `${parts[0]}, ${parts[1]} and ${parts[2]}` : parts.join(" and ")
}

const connectStep = (h: H, model: Model): Html => {
	const status = cloudflareStatusOf(model)
	const usage = cloudflareUsageOf(model)
	const isConnected = status !== null && status.connected
	const isWaiting = model.connect.active !== null && !isConnected
	const discovering = isConnected && status.zones.length === 0 && status.workers === null
	return flowColumns(
		h,
		[
			stepCard(
				h,
				{
					icon: "CloudflareBrandIcon",
					title: isConnected ? "Cloudflare authorized" : "Authorize Cloudflare",
					note: "Read-only",
				},
				isConnected
					? [
							h.p(
								[h.Class("text-sm text-muted-foreground")],
								["Maple can read these accounts. Zones and Workers are found on their own."],
							),
							accountList(h, connectedAccountsOf(status)),
							h.div(
								[h.Class("flex flex-wrap items-center gap-3")],
								[
									connectButton(h, model, "Authorize again", "outline"),
									h.span(
										[h.Class("text-xs text-muted-foreground")],
										["Missing an account? Authorize again and tick it in Cloudflare."],
									),
								],
							),
						]
					: [
							h.p(
								[h.Class("text-sm text-muted-foreground")],
								[
									"Cloudflare opens in a new window. Sign in, pick the accounts Maple may read and approve.",
								],
							),
							connectButton(h, model, "Connect Cloudflare"),
						],
			),
			isWaiting
				? statusRow(h, { tone: "working", text: "Waiting for you to approve in Cloudflare…" })
				: !isConnected
					? statusRow(h, {
							tone: "idle",
							text: "Not authorized yet. This step completes on its own when you approve in Cloudflare.",
						})
					: discovering
						? statusRow(h, {
								tone: "working",
								text: `Authorized ${cloudflareReach(status)}. Finding zones and Workers…`,
							})
						: statusRow(h, {
								tone: "ok",
								text: `Authorized. ${foundLine(status, usage)} found.`,
							}),
		],
		readsRail(h),
	)
}

/** The 24h backfill's progress under its row. */
const progressBar = (h: H, progress: number): Html =>
	meter(h, { value: progress, label: "Backfill progress", className: "mt-1 max-w-sm" })

const accessRow = (status: CloudflareIntegrationStatus): CheckRow => {
	const error = accountErrorOf(status)
	if (error !== null) return { state: "failed", title: "Access lost", detail: error.summary }
	if (!status.analyticsCapable)
		return {
			state: "failed",
			title: "Access works: partly",
			detail: "Cloudflare granted zone access but not analytics, so traffic numbers cannot be read yet.",
		}
	return { state: "done", title: "Access works", detail: `Read access to ${cloudflareReach(status)}` }
}

const resourceRows = (
	status: CloudflareIntegrationStatus,
	usage: CloudflareUsageResponse | null,
	phase: CloudflareIngestPhase | null,
): ReadonlyArray<CheckRow> => {
	if (status.zones.length === 0 && status.workers === null)
		return [
			phase?.kind === "stalled"
				? {
						state: "failed",
						title: "No zones or Workers found",
						detail: "The grant covers no zones or Workers. Authorize again and tick an account that has them.",
					}
				: {
						state: "working",
						title: "Finding zones and Workers",
						detail: describeCloudflareIngestPhase({ kind: "discovering" }).description,
					},
		]
	const enabled = status.zones.filter((zone) => zone.enabled && zone.watched !== false).length
	const workers = workerServicesOf(usage).length
	return [
		{
			state: "done",
			title: `Zones found: ${status.zones.length}`,
			detail: enabled === status.zones.length ? "Watching all of them" : `Watching ${enabled}`,
		},
		...(status.workers === null
			? []
			: [
					{
						state: "done",
						title: workers > 0 ? `Workers found: ${workers}` : "Workers",
						detail: "Added to the service map as they serve traffic",
					} satisfies CheckRow,
				]),
	]
}

const dataRow = (
	h: H,
	status: CloudflareIntegrationStatus,
	usage: CloudflareUsageResponse | null,
	phase: CloudflareIngestPhase | null,
): CheckRow => {
	if (!status.analyticsCapable || accountErrorOf(status) !== null)
		return {
			state: "waiting",
			title: "Backfill and first data",
			detail: "Starts on its own within a minute of updating access",
		}
	if (phase === null || phase.kind === "discovering")
		return { state: "waiting", title: "Backfill the last 24 hours" }
	const described = describeCloudflareIngestPhase(phase)
	switch (phase.kind) {
		case "collecting":
		case "partial":
			return { state: "working", title: described.title, detail: described.description }
		case "backfilling":
			return {
				state: "working",
				title: described.title,
				detail: "Live data is already flowing. Older windows arrive a few at a time.",
				extra: progressBar(h, phase.progress),
			}
		case "stalled":
			return { state: "failed", title: described.title, detail: described.description }
		case "live":
			return {
				state: "done",
				title: "Backfilled the last 24 hours",
				detail:
					usage === null
						? null
						: `${formatNumber(usage.totalRequests)} requests in the last 24 hours`,
			}
	}
}

const liveRow = (phase: CloudflareIngestPhase | null): CheckRow =>
	phase?.kind === "live" || phase?.kind === "backfilling"
		? { state: "done", title: "Live", detail: "Maple polls every 5 minutes" }
		: {
				state: "waiting",
				title: "Live",
				detail: "First live batch per signal. Cloudflare publishes every 5 minutes.",
			}

/** Missing analytics scopes: the one thing left to do, with the way to do it. */
const updateAccess = (h: H, model: Model): Html =>
	alert(h, { variant: "warn" }, [
		icon(h, "CircleWarningIcon"),
		alertTitle(h, ["Update access to collect analytics"]),
		alertDescription(h, [
			"Maple can see your zones and Workers, but the Cloudflare grant is missing the analytics permission, so traffic numbers cannot be read yet. This usually happens when a box was unticked on the consent screen.",
		]),
		alertAction(h, [connectButton(h, model, "Update access")]),
	])

const liveStep = (h: H, model: Model): Html => {
	const status = cloudflareStatusOf(model)
	const usage = cloudflareUsageOf(model)
	const phase = cloudflarePhaseOf(model)
	const isLive = phase?.kind === "live"
	return flowColumns(
		h,
		[
			...(status !== null && status.connected && !status.analyticsCapable
				? [updateAccess(h, model)]
				: []),
			savedBanner(
				h,
				"Saved as a source. Safe to leave; collection keeps running.",
				"Nothing to apply in Cloudflare",
			),
			liveChecklist(h, {
				title: isLive ? "Cloudflare is live" : "Going live",
				rows:
					status === null || !status.connected
						? [{ state: "waiting", title: "Waiting for Cloudflare's status" }]
						: [
								accessRow(status),
								...resourceRows(status, usage, phase),
								dataRow(h, status, usage, phase),
								liveRow(phase),
							],
			}),
		],
		showsUpRail(h),
	)
}

export const cloudflareFlowView = (h: H, model: Model, stage: FlowStage): Html =>
	stage === "live" ? liveStep(h, model) : connectStep(h, model)
