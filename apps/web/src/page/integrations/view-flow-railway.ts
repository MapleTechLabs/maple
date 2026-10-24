import type { RailwayIntegrationStatus } from "@maple/domain/http"
import { countLabel } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import {
	type CheckRow,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { relativeTime } from "../kit/relative-time"
import { catalogEntry } from "./catalog"
import { fold } from "./derive"
import type { FlowStage } from "./flow"
import { railwayReach } from "./flow-railway"
import { Message } from "./message"
import type { Model } from "./model"
import { unsyncedEnvironments } from "./railway"
import { railwayTokenForm } from "./view-railway-token"

// Railway in the connect flow: paste a token, then watch the first sync land.

type H = HtmlBuilder<Message>

const DOCS_HREF = catalogEntry("railway").docsUrl

const readsRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{
				icon: "LayersIcon",
				title: "Projects, environments, services",
				detail: "Each service is tracked per environment",
			},
			{ icon: "MicrochipIcon", title: "Resources", detail: "CPU and memory per replica" },
			{
				icon: "NetworkNodesIcon",
				title: "Network and disk",
				detail: "Traffic in and out, volume and ephemeral disk",
			},
			{
				icon: "ClockIcon",
				title: "Last hour, then every 5 minutes",
				detail: "Sampled each minute, so charts start full",
			},
		],
		trust: "Maple only reads metrics with this token and never changes anything in Railway. Delete the token in Railway to revoke access.",
		timeNote: "Takes about 1 minute",
		docs: DOCS_HREF === undefined ? null : { label: "Railway setup docs", href: DOCS_HREF },
	})

const showsUpRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ServerIcon",
				title: "Infrastructure, Railway",
				detail: "One row per environment and service",
			},
			{
				icon: "ChartLineIcon",
				title: "Next to your traces",
				detail: "Matched on the Railway service name",
			},
			{ icon: "GearIcon", title: "Source page", detail: "Sync now, Update credential, Disconnect" },
		],
		timeNote: "First live sample within 5 minutes",
		docs: DOCS_HREF === undefined ? null : { label: "Docs", href: DOCS_HREF },
	})

/** Each project the token sees, with how many services it has. */
const projectChips = (h: H, status: RailwayIntegrationStatus): Html => {
	const services = status.environments.reduce<Record<string, number>>(
		(acc, environment) => ({
			...acc,
			[environment.projectName]: (acc[environment.projectName] ?? 0) + environment.serviceCount,
		}),
		{},
	)
	return foundChips(
		h,
		Object.entries(services).map(([project, count]) => ({
			label: project,
			detail: countLabel(count, "service"),
		})),
	)
}

/** "Workspace Acme, 2 environments", or just the count when the token has no workspace name. */
const railwayStatusLine = (status: RailwayIntegrationStatus): string => {
	const count = countLabel(status.environments.length, "environment")
	const reach = railwayReach(status)
	return reach === count ? count : `${reach}, ${count}`
}

const statusOf = (model: Model): RailwayIntegrationStatus | null =>
	fold(
		model.statuses.railway,
		(data): RailwayIntegrationStatus | null => data,
		() => null,
	)

const connectStep = (h: H, model: Model): Html => {
	const card = model.railwayCard
	const status = statusOf(model)
	const isConnected = status !== null && status.connected && !status.authFailed
	const showsForm = !isConnected || card.isRotating
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "KeyIcon", title: "Paste a Railway API token", note: "Encrypted at rest" }, [
				showsForm
					? railwayTokenForm(h, card.connect, {
							mode: isConnected ? "rotate" : "connect",
							canCancel: isConnected,
						})
					: button(
							h,
							{
								variant: "outline",
								size: "sm",
								className: "w-fit",
								attributes: [h.OnClick(Message.ClickedRailwayRotate())],
							},
							["Use a different token"],
						),
			]),
			card.connect.isSubmitting
				? statusRow(h, {
						tone: "working",
						text: "Checking the token and pulling the last hour of metrics…",
					})
				: isConnected && status !== null
					? statusRow(
							h,
							{
								tone: "ok",
								text: `Token works. ${railwayStatusLine(status)}.`,
							},
							status.environments.length === 0 ? [] : [projectChips(h, status)],
						)
					: statusRow(h, {
							tone: "idle",
							text: "Paste a token. Maple checks it and pulls the last hour right away.",
						}),
		],
		readsRail(h),
	)
}

const liveRows = (
	h: H,
	model: Model,
	status: RailwayIntegrationStatus,
	timeZone: string,
): ReadonlyArray<CheckRow> => {
	const total = status.environments.length
	const failing = status.environments.filter((environment) => environment.lastError !== null).length
	const queued = unsyncedEnvironments(status)
	const synced = total - queued - failing
	return [
		status.authFailed
			? {
					state: "failed",
					title: "Token rejected",
					detail: "Railway rejected the saved token, so polling is paused. Go back and paste a new one.",
				}
			: { state: "done", title: "Token works", detail: railwayReach(status) },
		total === 0
			? {
					state: "failed",
					title: "No environments found",
					detail: "This token can't see any projects yet.",
				}
			: {
					state: "done",
					title: `${countLabel(total, "environment")} found`,
					detail: `${countLabel(
						status.environments.reduce((sum, environment) => sum + environment.serviceCount, 0),
						"service",
					)}. PR environments are skipped.`,
				},
		failing > 0
			? {
					state: "failed",
					title: "Backfilling the last hour",
					detail: `${countLabel(failing, "environment")} failed: ${status.environments.find((environment) => environment.lastError !== null)?.lastError ?? ""}`,
				}
			: queued > 0
				? {
						state: "working",
						title: "Backfilling the last hour",
						detail: `${synced} of ${total} environments synced`,
					}
				: {
						state: "done",
						title: "Backfilled the last hour",
						detail: countLabel(total, "environment"),
					},
		status.lastSyncedAt === null
			? { state: "waiting", title: "First live sample", detail: "Next sync within 5 minutes" }
			: {
					state: "done",
					title: "Syncing every 5 minutes",
					meta: relativeTime(h, {
						value: status.lastSyncedAt,
						nowMs: model.nowMs,
						timeZone,
						prefix: "synced",
					}),
				},
	]
}

const liveStep = (h: H, model: Model, timeZone: string): Html => {
	const status = statusOf(model)
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				"Saved as a source. Safe to leave; syncing keeps running.",
				"Nothing to apply in Railway",
			),
			liveChecklist(h, {
				rows:
					status === null || !status.connected
						? [{ state: "waiting", title: "Waiting for Railway's status" }]
						: liveRows(h, model, status, timeZone),
			}),
		],
		showsUpRail(h),
	)
}

export const railwayFlowView = (h: H, model: Model, stage: FlowStage, timeZone: string): Html =>
	stage === "live" ? liveStep(h, model, timeZone) : connectStep(h, model)
