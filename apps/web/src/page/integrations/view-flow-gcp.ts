import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	gcpLogState,
	gcpMetricsState,
	gcpScopeLabel,
	gcpScriptNeeded,
	gcpSetupRunning,
} from "../../components/integrations/gcp-connector-state"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { skeleton } from "../../ui/skeleton"
import {
	type CheckRow,
	choiceTiles,
	flowColumns,
	flowRail,
	foundChips,
	liveChecklist,
	savedBanner,
	statusRow,
	stepCard,
} from "../kit/connect-flow"
import { relativeTime } from "../kit/relative-time"
import type { FlowStage } from "./flow"
import { collectsLabel, flowConnector, gcpFlow, scopeCheck } from "./flow-gcp"
import { createRequest } from "./gcp-configure-derive"
import { DOCS, SCOPES } from "./gcp-configure-copy"
import type { ConfigureModel, SetupMethod } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpConnectors, gcpInfraHref, gcpLogsHref } from "./update-gcp"
import { metricsAvailable } from "./update-gcp-configure"
import { collectFields } from "./view-gcp-configure-collect"
import { logFilter } from "./view-gcp-configure-filter"
import { methodSetup } from "./view-gcp-configure-method"
import { scriptSection } from "./view-gcp-configure-run"
import { scopeFields } from "./view-gcp-configure-scope"
import { GCP_TITLE } from "./view-gcp-parts"

// Google Cloud in the connect flow: a scope by ID and how to apply the setup, what to collect,
// then the setup itself and a checklist that ticks as Google Cloud reports back.

type H = HtmlBuilder<Message>

const METHODS = [
	{
		value: "script",
		title: "Cloud Shell script",
		tag: "Recommended",
		description: "Runs a gcloud script in Cloud Shell. You can read it before it runs. About a minute.",
	},
	{
		value: "manual",
		title: "Console steps",
		tag: null,
		description: "Create each resource yourself in the Google Cloud console. About 15 minutes.",
	},
	{
		value: "terraform",
		title: "Terraform",
		tag: null,
		description: "A maple.tf for the google provider, to review and apply from your repo.",
	},
	{
		value: "alchemy",
		title: "Alchemy",
		tag: null,
		description: "A maple.ts for alchemy/GCP, to review and deploy from your repo.",
	},
] as const satisfies ReadonlyArray<
	Readonly<{ value: SetupMethod; title: string; tag: string | null; description: string }>
>

const methodChoice = (h: H, configure: ConfigureModel): Html =>
	h.div(
		[h.Class("flex flex-col gap-3 border-t border-border pt-5")],
		[
			h.h3([h.Class(GCP_TITLE)], ["How do you want to apply the setup?"]),
			choiceTiles(
				h,
				METHODS.map((method) => ({
					title: method.title,
					description: method.description,
					tag: method.tag ?? undefined,
					isSelected: configure.method === method.value,
					onSelect: Message.ClickedGcpMethod({ method: method.value }),
				})),
			),
		],
	)

const connectRail = (h: H): Html =>
	h.div(
		[h.Class("flex flex-col gap-3")],
		[
			flowRail(h, {
				eyebrow: "Which scope to pick",
				items: [
					{
						icon: "CubeIcon",
						title: "Project",
						detail: "One project. Its ID, like acme-prod, not the name or number.",
					},
					{
						icon: "FolderIcon",
						title: "Folder",
						detail: "Every project in it, including new ones. Digits only.",
					},
					{
						icon: "LayersIcon",
						title: "Organization",
						detail: "Every project you own. Digits only.",
					},
				],
				trust: "An ID can't be changed later. To watch a different scope, add another account from the source page.",
			}),
			flowRail(h, {
				eyebrow: "Before you start",
				items: [
					{
						icon: "UserIcon",
						title: "Owner on the host project",
						detail: "Or the roles listed in the docs",
					},
					{
						icon: "ChartLineIcon",
						title: "Billing linked for metrics",
						detail: "Logs work without it",
					},
				],
				timeNote: "Takes about 3 minutes",
				docs: { label: "Setup docs", href: DOCS },
			}),
		],
	)

const connectStatus = (h: H, configure: ConfigureModel, connector: V2GcpConnector | null): Html => {
	if (connector !== null)
		return statusRow(
			h,
			{ tone: "ok", text: `${gcpScopeLabel(connector)} is saved as a source. An ID can't be changed.` },
			[
				foundChips(h, [
					{ label: connector.scope_id, detail: connector.scope_type },
					...(connector.scope_type === "project"
						? []
						: [{ label: connector.project_id, detail: "host" }]),
				]),
			],
		)
	const label = SCOPES[configure.scopeType].idLabel
	switch (scopeCheck(configure)) {
		case "empty":
			return statusRow(h, {
				tone: "idle",
				text: `Enter the ${label}. Maple checks access when the setup runs.`,
			})
		case "bad-id":
			return statusRow(h, { tone: "error", text: `That doesn't look like a ${label}.` })
		case "bad-host":
			return statusRow(h, {
				tone: configure.hostProjectId.value.trim() === "" ? "idle" : "error",
				text: `${label} looks right. Waiting for a valid host project ID.`,
			})
		case "ready":
			return statusRow(h, {
				tone: "ok",
				text: `${label} looks right. Maple checks access when the setup runs.`,
			})
	}
}

const connectStep = (h: H, model: Model, configure: ConfigureModel): Html => {
	const connector = flowConnector(model)
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "GoogleCloudMonoIcon", title: "Enter what Maple should watch" }, [
				...(connector === null ? scopeFields(h, model, configure, gcpConnectors(model)) : []),
				methodChoice(h, configure),
			]),
			connectStatus(h, configure, connector),
		],
		connectRail(h),
	)
}

const chooseRail = (h: H): Html =>
	flowRail(h, {
		eyebrow: "What Maple reads",
		items: [
			{
				icon: "UnorderedListIcon",
				title: "Google Cloud's logs",
				detail: "Request, audit and managed-service logs",
			},
			{
				icon: "ServerIcon",
				title: "Workloads, no agents",
				detail: "Cloud Run, GKE, Compute Engine, Cloud SQL and more",
			},
			{
				icon: "ClockIcon",
				title: "Every 5 minutes",
				detail: "Metrics and the resource list, read-only",
			},
		],
		trust: "Maple gets a read-only service account and a log sink, nothing else. Disconnect gives you the matching cleanup script.",
		docs: { label: "Docs", href: DOCS },
	})

const chooseStep = (h: H, model: Model, configure: ConfigureModel): Html => {
	const connector = flowConnector(model)
	if (connector !== null)
		return flowColumns(
			h,
			[
				...(connector.logs_enabled
					? [
							stepCard(h, { icon: "LayersIcon", title: "Log filter" }, [
								logFilter(h, configure, {
									sinkExists: connector.applied_logs_enabled === true,
								}),
							]),
						]
					: []),
				statusRow(h, {
					tone: "ok",
					text: `Saved: ${collectsLabel(connector)}. Change what it collects later with Edit data on the source page.`,
				}),
			],
			chooseRail(h),
		)
	return flowColumns(
		h,
		[
			stepCard(h, { icon: "LayersIcon", title: "Choose what to collect" }, [
				collectFields(h, {
					flags: configure.newFlags,
					metricsAvailable: metricsAvailable(model),
					logFilter: logFilter(h, configure, { sinkExists: false }),
				}),
				button(
					h,
					{
						className: "w-fit",
						isLoading: configure.isCreating,
						isDisabled: Option.isNone(createRequest(configure)),
						attributes: [h.OnClick(Message.SubmittedGcpCreate())],
					},
					["Create connection"],
				),
			]),
			configure.isCreating
				? statusRow(h, { tone: "working", text: "Creating the connection…" })
				: configure.createError !== null
					? statusRow(h, { tone: "error", text: configure.createError })
					: statusRow(h, {
							tone: "idle",
							text: "Nothing changes in Google Cloud yet. Creating the connection saves it as a source and prepares its setup.",
						}),
		],
		chooseRail(h),
	)
}

/** The setup and the confirmation, as the checklist's first row. */
const setupRow = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	timeZone: string,
	overdue: boolean,
): CheckRow => {
	const byScript = configure.method === "script"
	const title = byScript ? "Script run" : "Setup applied in Google Cloud"
	if (gcpScriptNeeded(connector, model.nowMs) === null && !gcpSetupRunning(connector, model.nowMs))
		return {
			state: "done",
			title,
			meta:
				connector.setup_reported_at === null
					? null
					: relativeTime(h, { value: connector.setup_reported_at, nowMs: model.nowMs, timeZone }),
		}
	if (gcpSetupRunning(connector, model.nowMs))
		return { state: "working", title, detail: "The script is reporting back" }
	if (overdue)
		return {
			state: "failed",
			title,
			detail: "No report from the script yet. If it stopped with an error, fix what it names and run it again; it continues where it stopped.",
		}
	return {
		state: "waiting",
		title,
		detail: byScript
			? "Waiting for the script to report back"
			: "Confirmed by the first log or metrics read",
	}
}

const logsRow = (
	h: H,
	model: Model,
	connector: V2GcpConnector,
	timeZone: string,
): ReadonlyArray<CheckRow> => {
	const log = gcpLogState(connector, model.nowMs)
	const title = "Logs arrive"
	switch (log.kind) {
		case "off":
			return []
		case "receiving":
		case "idle":
			return [
				{
					state: "done",
					title,
					meta: relativeTime(h, {
						value: log.lastLogReceivedAt,
						nowMs: model.nowMs,
						timeZone,
						prefix: "last entry",
					}),
				},
			]
		case "failing":
			return [{ state: "failed", title, detail: log.error }]
		case "waiting":
			return [{ state: "working", title, detail: "First entries within about 10 minutes" }]
		case "setup-pending":
		case "setup-running":
			return [{ state: "waiting", title, detail: "After the setup" }]
	}
}

const metricsRow = (
	h: H,
	model: Model,
	connector: V2GcpConnector,
	timeZone: string,
): ReadonlyArray<CheckRow> => {
	const metrics = gcpMetricsState(connector, model.nowMs)
	const title = "Metrics arrive"
	switch (metrics.kind) {
		case "off":
			return []
		case "receiving":
			return [
				{
					state: "done",
					title,
					meta: relativeTime(h, {
						value: metrics.lastMetricsReceivedAt,
						nowMs: model.nowMs,
						timeZone,
						prefix: "last read",
					}),
				},
			]
		case "failing":
		case "incomplete":
			return [{ state: "failed", title, detail: metrics.error }]
		case "stalled":
			return [{ state: "failed", title, detail: "No read for half an hour" }]
		case "waiting":
			return [{ state: "working", title, detail: "First read within about 10 minutes" }]
		case "setup-pending":
		case "setup-running":
			return [{ state: "waiting", title, detail: "After the setup" }]
	}
}

const showsUpRail = (h: H, connector: V2GcpConnector | null): Html =>
	flowRail(h, {
		eyebrow: "Where it shows up",
		items: [
			{
				icon: "ServerIcon",
				title: "Infrastructure, Google Cloud",
				detail: "Workloads, databases and resources",
			},
			{ icon: "UnorderedListIcon", title: "Logs", detail: "Each entry carries this connection's id" },
			{ icon: "GearIcon", title: "Source page", detail: "Edit data, Reconnect, Disconnect" },
		],
		trust: "Nothing outside the setup's list. Disconnect gives you the matching cleanup script.",
		docs:
			connector === null
				? null
				: connector.logs_enabled
					? { label: "View logs", href: gcpLogsHref(connector) }
					: { label: "View infrastructure", href: gcpInfraHref(connector) },
	})

const liveStep = (h: H, model: Model, configure: ConfigureModel, timeZone: string): Html => {
	const connector = flowConnector(model)
	if (connector === null)
		return flowColumns(
			h,
			[liveChecklist(h, { rows: [{ state: "waiting", title: "Waiting for the connection" }] })],
			showsUpRail(h, null),
		)
	const live = gcpFlow(model).live
	const confirmed =
		gcpScriptNeeded(connector, model.nowMs) === null && !gcpSetupRunning(connector, model.nowMs)
	// Attention with the setup not confirmed is the script's silence: the setup row names it.
	const overdue = live === "attention" && !confirmed
	return flowColumns(
		h,
		[
			savedBanner(
				h,
				"Saved as a source. Close this tab any time; the checklist continues on the source page.",
			),
			...(confirmed
				? []
				: [
						stepCard(
							h,
							{ icon: "SquareTerminalIcon", title: "Apply the setup in Google Cloud" },
							configure.method === "script"
								? [scriptSection(h, model, configure, connector)]
								: methodSetup(h, model, configure, connector),
						),
					]),
			live === "healthy"
				? statusRow(h, {
						tone: "ok",
						text: "Confirmed: data shows up in Maple on its own from now on.",
					})
				: live === "attention"
					? statusRow(h, { tone: "error", text: "Something needs a fix. The checklist names it." })
					: confirmed
						? statusRow(h, {
								tone: "working",
								text: "Google Cloud matches this configuration. Waiting for the first data.",
							})
						: gcpSetupRunning(connector, model.nowMs)
							? statusRow(h, { tone: "working", text: "The script is reporting back." })
							: statusRow(h, {
									tone: "idle",
									text:
										configure.method === "script"
											? "Waiting for the script to report back. This step completes on its own."
											: "Waiting for Google Cloud. A setup without the script is confirmed by the first log or metrics read.",
								}),
			liveChecklist(h, {
				title: "Live checklist",
				meta: "Updates on its own",
				rows: [
					setupRow(h, model, configure, connector, timeZone, overdue),
					...logsRow(h, model, connector, timeZone),
					...metricsRow(h, model, connector, timeZone),
				],
			}),
		],
		showsUpRail(h, connector),
	)
}

export const gcpFlowView = (h: H, model: Model, stage: FlowStage, timeZone: string): Html => {
	const configure = model.gcpCard.configure
	if (configure === null) return flowColumns(h, [skeleton(h, "h-60 w-full rounded-lg")], null)
	return stage === "live"
		? liveStep(h, model, configure, timeZone)
		: stage === "choose"
			? chooseStep(h, model, configure)
			: connectStep(h, model, configure)
}
