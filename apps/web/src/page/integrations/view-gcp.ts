import type { V2GcpConnector, V2GcpIntegration } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import {
	GCP_CONNECTION_LABEL,
	GCP_STATE_ORDER,
	gcpConnectionState,
	gcpWorstState,
} from "../../components/integrations/gcp-connector-state"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../route"
import { button, linkButton } from "../../ui/button"
import { errorState } from "../../ui/error-state"
import { panel } from "../../ui/panel"
import { skeleton } from "../../ui/skeleton"
import { statusDot } from "../../ui/status-dot"
import { sectionHeading } from "../kit/section-heading"
import { HEALTH_TONE } from "./derive"
import { integrationNotice } from "./kit/notice"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpConnectors } from "./update-gcp"
import { gcpConnection } from "./view-gcp-connection"
import { gcpConfigure } from "./view-gcp-configure"
import { gcpDialogs } from "./view-gcp-dialogs"
import { copyScriptButton, GCP_TITLE, openCloudShellButton } from "./view-gcp-parts"
import { usageBand } from "./view-gcp-workloads"

// `GcpIntegrationCard` and `GcpHeaderStatus`.

type H = HtmlBuilder<Message>

/** A removed connection whose cleanup script was never seen to run. */
const cleanupPanels = (h: H, model: Model): ReadonlyArray<Html> =>
	model.gcpCard.removed.map((entry) =>
		panel(h, { className: "gap-3 border-severity-warn-a3 bg-severity-warn-a1 px-4 py-3" }, [
			h.div(
				[],
				[
					h.h3(
						[h.Class(GCP_TITLE)],
						[
							entry.label,
							" ",
							entry.reported ? "disconnected, may not be cleaned up" : "disconnected",
						],
					),
					h.p(
						[h.Class("text-xs/5 text-pretty text-muted-foreground")],
						[
							entry.reported
								? "Google Cloud may still hold Maple's resources, billed by Google. Run the cleanup script, or remove them with Terraform, Alchemy or in the console, then dismiss this."
								: "If any of it was set up, Google bills for it until it is removed. The cleanup script removes it, however it was made.",
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

const FLOW_HREF = hrefOf(AppRoute.SourcesNew({ search: { integration: "gcp" } }))

/** A source page whose connection was removed: the way back is the connect flow. */
const gcpReconnect = (h: H, text: string): Html =>
	integrationNotice(h, {
		message: text,
		action: linkButton(h, { size: "sm", href: FLOW_HREF }, ["Reconnect"]),
	})

const byStatus = (
	h: H,
	model: Model,
	status: V2GcpIntegration,
	timeZone: string,
	focusId: string | null,
): Html => {
	// A Google Cloud source stands for one connector: its Connection tab shows only that one.
	const connectors =
		focusId === null
			? status.connectors
			: status.connectors.filter((connector) => connector.id === focusId)
	// Focused on a source, the removal dialogs render with its header actions (`actionsEmbed`).
	const dialogs = [
		...(focusId === null ? gcpDialogs(h, model, timeZone) : []),
		...gcpConfigure(h, model, timeZone),
	]
	if (connectors.length === 0)
		return h.div(
			[h.Class("flex flex-col gap-4")],
			[
				...cleanupPanels(h, model),
				gcpReconnect(
					h,
					focusId === null
						? "Google Cloud is not connected."
						: "This Google Cloud connection no longer exists.",
				),
				...dialogs,
			],
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
						title: focusId === null ? "Connections" : "Connection",
						count: connectors.length > 1 ? String(connectors.length) : undefined,
						actions:
							focusId === null
								? linkButton(h, { size: "sm", variant: "outline", href: FLOW_HREF }, [
										"Add another account",
									])
								: undefined,
					}),
					...ordered.map((connector) => gcpConnection(h, model, connector, timeZone)),
				],
			),
			...dialogs,
		],
	)
}

export const gcpCard = (h: H, model: Model, timeZone: string, focusId: string | null = null): Html =>
	AsyncData.match(model.statuses.gcp.data, {
		onIdle: () => skeleton(h, "h-40 w-full rounded-md"),
		onLoading: () => skeleton(h, "h-40 w-full rounded-md"),
		onFailure: (failure) =>
			errorState(h, {
				failure,
				title: "Couldn't load the Google Cloud integration",
				onRetry: Message.ClickedRetryStatus({ name: "gcp" }),
			}),
		onStale: ({ data }) => byStatus(h, model, data, timeZone, focusId),
		onRefreshing: (data) => byStatus(h, model, data, timeZone, focusId),
		onSuccess: (data) => byStatus(h, model, data, timeZone, focusId),
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
