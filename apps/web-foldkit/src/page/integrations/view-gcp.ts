import type { V2GcpConnector, V2GcpIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import {
	GCP_CONNECTION_LABEL,
	GCP_STATE_ORDER,
	gcpConnectionState,
	gcpWorstState,
} from "@maple/web/components/integrations/gcp-connector-state"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { icon } from "../../ui/icon"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { sectionHeading } from "../kit/section-heading"
import {
	integrationEmpty,
	integrationEmptyCard,
	integrationEmptyFeatures,
	integrationEmptyHint,
	integrationEmptyMedia,
} from "../infra-integrations/kit/integration-empty"
import { GCP_ACCENT } from "./catalog"
import { HEALTH_TONE } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpConnectors } from "./update-gcp"
import { gcpConnection } from "./view-gcp-connection"
import { gcpDialogs } from "./view-gcp-dialogs"
import { copyScriptButton, GCP_TITLE, openCloudShellButton } from "./view-gcp-parts"
import { usageBand } from "./view-gcp-workloads"

// `GcpIntegrationCard` and `GcpHeaderStatus` (components/integrations/gcp-integration-card.tsx).
// TODO(gcp-configure): the `GcpConfigure` wizard is not ported; its buttons set the target only.

type H = HtmlBuilder<Message>

const newConnection = Message.ClickedGcpConfigure({ target: { _tag: "New" } })

/** A removed connection whose cleanup script was never seen to run. */
const cleanupPanels = (h: H, model: Model): ReadonlyArray<Html> =>
	model.gcpCard.removed.map((entry) =>
		panel(h, { className: "gap-3 border-severity-warn/32 bg-severity-warn/4 px-4 py-3" }, [
			h.div(
				[],
				[
					h.h3(
						[h.Class(GCP_TITLE)],
						[entry.label, " ", entry.reported ? "disconnected, not cleaned up" : "disconnected"],
					),
					h.p(
						[h.Class("text-xs/5 text-pretty text-muted-foreground")],
						[
							entry.reported
								? "Google Cloud still holds what the setup script created, and bills for it. Dismiss this once the cleanup script has run."
								: "If the setup script ran part of the way, the cleanup script removes what it created.",
						],
					),
				],
			),
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					openCloudShellButton(h, entry.hostProjectId),
					copyScriptButton(h, model, `removed-${entry.id}`, entry.cleanupScript, "cleanup script"),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							attributes: [h.OnClick(Message.ClickedDismissCleanup({ id: entry.id }))],
						},
						["Dismiss"],
					),
				],
			),
		]),
	)

const emptyState = (h: H): Html =>
	integrationEmpty(h, [
		integrationEmptyFeatures(h, [
			{
				label: "Logs",
				title: "Google Cloud's logs",
				description:
					"Request, audit and managed-service logs. GKE container logs stay out by default.",
			},
			{
				label: "Metrics",
				title: "Workloads, no agents",
				description: "Cloud Run, GKE, Compute Engine, Cloud SQL and more, read every 5 minutes.",
			},
			{
				label: "Access",
				title: "One script, read-only",
				description: "You run it in Cloud Shell. No keys, no write access for Maple.",
			},
		]),
		integrationEmptyCard(h, [
			integrationEmptyMedia(h, {
				icon: "GoogleCloudIcon",
				backerIcon: "GoogleCloudMonoIcon",
				accent: GCP_ACCENT,
			}),
			integrationEmptyHint(h, [
				"Connect a project, folder or organization. Its logs, workloads and resources appear here.",
			]),
			button(h, { attributes: [h.OnClick(newConnection)] }, [
				icon(h, "GoogleCloudMonoIcon"),
				"Connect Google Cloud",
			]),
		]),
	])

const byStatus = (h: H, model: Model, status: V2GcpIntegration, timeZone: string): Html => {
	const connectors = status.connectors
	const dialogs = gcpDialogs(h, model, timeZone)
	if (connectors.length === 0)
		return h.div(
			[h.Class("flex flex-col gap-4")],
			[...cleanupPanels(h, model), emptyState(h), ...dialogs],
		)
	const ordered = connectors.toSorted(
		(a, b) =>
			GCP_STATE_ORDER.indexOf(gcpConnectionState(a, model.nowMs)) -
			GCP_STATE_ORDER.indexOf(gcpConnectionState(b, model.nowMs)),
	)
	const band = usageBand(h, model, connectors)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			...cleanupPanels(h, model),
			...(band === null ? [] : [band]),
			h.section(
				[h.Class("flex min-w-0 flex-col gap-3 font-display")],
				[
					sectionHeading(h, {
						title: "Connections",
						count: connectors.length > 1 ? String(connectors.length) : undefined,
						actions: button(
							h,
							{ size: "sm", variant: "outline", attributes: [h.OnClick(newConnection)] },
							["Add connection"],
						),
					}),
					...ordered.map((connector) => gcpConnection(h, model, connector, timeZone)),
				],
			),
			...dialogs,
		],
	)
}

export const gcpCard = (h: H, model: Model, timeZone: string): Html =>
	AsyncData.match(model.statuses.gcp.data, {
		onIdle: () => skeleton(h, "h-40 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Failed to load the Google Cloud integration",
				onRetry: Message.ClickedRetryStatus({ name: "gcp" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone),
		onRefreshing: (data) => byStatus(h, model, data, timeZone),
		onSuccess: (data) => byStatus(h, model, data, timeZone),
	})

/** `GcpHeaderStatus`: the worst connection's state, how many share it, how many projects send data. */
export const gcpHeaderStatus = (h: H, model: Model): Html => {
	const connectors: ReadonlyArray<V2GcpConnector> = gcpConnectors(model)
	const states = connectors.map((connector) => gcpConnectionState(connector, model.nowMs))
	const worst = gcpWorstState(states)
	const inWorst = states.filter((state) => state === worst).length
	const projects = connectors.reduce(
		(sum, connector) =>
			sum + (connector.scope_type === "project" ? 1 : connector.discovered_project_count),
		0,
	)
	return h.div(
		[h.Class("flex items-center gap-1.5 font-display text-ui/5 text-muted-foreground")],
		[
			statusDot(h, {
				tone: HEALTH_TONE[worst === "attention" || worst === "healthy" ? worst : "pending"],
			}),
			GCP_CONNECTION_LABEL[worst],
			...(inWorst < connectors.length ? [` · ${inWorst} of ${connectors.length} connections`] : []),
			...(projects > 1 ? [` · ${countLabel(projects, "project")}`] : []),
		],
	)
}
