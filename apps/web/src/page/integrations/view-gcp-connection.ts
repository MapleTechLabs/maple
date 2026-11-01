import type { V2GcpConnector } from "@maple/domain/http/v2"
import { countLabel } from "@maple/ui/lib/format"
import { TONE_TEXT, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	GCP_LOG_STATUS,
	GCP_METRICS_STATUS,
	GCP_SCOPE_NAMES,
	type GcpCapability,
	gcpLogState,
	gcpMetricsState,
	gcpNothingSeen,
	gcpPendingChanges,
	gcpRunAsked,
	gcpScopeLabel,
	gcpScriptNeeded,
	gcpSetupRunning,
} from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { badge } from "../../ui/display"
import { icon } from "../../ui/icon"
import * as Menu from "../../ui/menu"
import type { MenuEntry } from "../../ui/menu-view"
import { panel } from "../../ui/panel"
import { rowActionsMenu } from "../../ui/row-actions-menu"
import { statusDot } from "../../ui/status-dot"
import { relativeTime } from "../kit/relative-time"
import { gcpMessage } from "../infra-integrations/gcp/gcp-message"
import { Message } from "./message"
import type { Model } from "./model"
import { gcpInfraHref, gcpLogsHref } from "./update-gcp"
import { gcpCommand } from "./view-gcp-parts"

// `GcpConnection`, `connectionIssues`, `signalText`, `Signal` and `Fact`.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>
type LogState = ReturnType<typeof gcpLogState>
type MetricsState = ReturnType<typeof gcpMetricsState>

// TODO(clerk): `useIsOrgAdmin`; self-hosted runs as the root admin, so every control shows.
const IS_ADMIN = true

const RETRIES = "Maple retries every 5 minutes. If this lasts an hour, write to support@maple.dev."

interface Issue {
	readonly key: string
	readonly tone: "crit" | "warn" | "info"
	readonly title: string
	readonly body?: Children
	readonly action?: Html
}

const runScript = (h: H, connector: V2GcpConnector, label: string): Html =>
	button(
		h,
		{
			size: "sm",
			attributes: [
				h.OnClick(
					Message.ClickedGcpConfigure({
						target: { _tag: "Connection", id: connector.id, stage: "apply" },
					}),
				),
			],
		},
		[label],
	)

/** Info issues are pending states (setup, first data), so their dot stays neutral, never healthy green. */
const dotTone = (tone: Issue["tone"] | "ok"): Tone => (tone === "info" ? "neutral" : tone)

/** `hasDot`: only a list of issues dots each one; a single issue's tone is the name row's dot. */
const issueNote = (h: H, issue: Issue, hasDot: boolean): Html =>
	h.div(
		[h.Role(issue.tone === "info" ? "note" : "status"), h.Class("flex gap-2.5")],
		[
			h.span(
				[h.Class("flex h-5 w-3.5 shrink-0 items-center justify-center")],
				hasDot ? [statusDot(h, { tone: dotTone(issue.tone), size: "lg" })] : [],
			),
			h.div(
				[h.Class("flex min-w-0 flex-col gap-1.5")],
				[
					h.p([h.Class("text-sm font-medium text-pretty")], [issue.title]),
					...(issue.body === undefined
						? []
						: [
								h.div(
									[h.Class("max-w-2xl text-xs/[18px] text-pretty text-muted-foreground")],
									issue.body,
								),
							]),
					...(issue.action === undefined ? [] : [h.div([h.Class("flex pt-1")], [issue.action])]),
				],
			),
		],
	)

/** What a connection needs said about it, worst first; empty when it is healthy. */
const connectionIssues = (
	h: H,
	model: Model,
	connector: V2GcpConnector,
	log: LogState,
	metrics: MetricsState,
): ReadonlyArray<Issue> => {
	const nowMs = model.nowMs
	const needed = gcpScriptNeeded(connector, nowMs)
	const repairs = needed === null ? gcpRunAsked(connector, nowMs)[0] : undefined
	const rerun = (capability: GcpCapability) =>
		repairs === capability && IS_ADMIN ? runScript(h, connector, "Set up again") : undefined
	const cleanedUp = connector.applied_logs_enabled === false && connector.applied_metrics_enabled === false
	const issues: Array<Issue> = []
	if (log.kind === "failing")
		issues.push({
			key: "logs-failing",
			tone: "crit",
			title: "Log forwarding is failing",
			body: [gcpMessage(h, log.error)],
			action: rerun("logs"),
		})
	if (metrics.kind === "failing")
		issues.push({
			key: "metrics-failing",
			tone: "crit",
			title: "Metrics can't be read",
			body: [gcpMessage(h, metrics.error)],
			action: rerun("metrics"),
		})
	if (needed !== null) {
		const lines =
			needed === "setup-pending"
				? [
						gcpNothingSeen(connector)
							? "Maple hasn't confirmed any of the setup yet. Finish it with the script, in the console or as code."
							: "Part of the setup isn't confirmed yet. A script run continues where it stopped; a setup in the console or as code is confirmed by its first data.",
					]
				: gcpPendingChanges(connector, nowMs)
		issues.push({
			key: "script",
			tone: "warn",
			title: needed === "setup-pending" ? "Setup pending" : "Changes not applied in Google Cloud",
			body: [
				lines.length === 1
					? h.p([], [lines[0] ?? ""])
					: h.ul(
							[h.Class("list-disc pl-4")],
							lines.map((line) => h.li([], [line])),
						),
				...(IS_ADMIN && needed === "changes-pending" && cleanedUp
					? [h.p([], ["To remove the connection instead, choose Disconnect in its menu."])]
					: []),
			],
			action: runScript(h, connector, needed === "setup-pending" ? "Reconnect" : "Apply changes"),
		})
	}
	if (metrics.kind === "incomplete")
		issues.push({
			key: "metrics-incomplete",
			tone: "warn",
			title: "Metrics are incomplete",
			body: [gcpMessage(h, metrics.error)],
			action: rerun("metrics"),
		})
	if (metrics.kind === "stalled")
		issues.push({
			key: "metrics-stalled",
			tone: "warn",
			title: "No metrics in 30 minutes",
			body: [RETRIES],
		})
	if (log.kind === "waiting" && log.overdue)
		issues.push({
			key: "logs-overdue",
			tone: "warn",
			title: "No log entry in 20 minutes",
			body: [
				"Nothing that passes the filter was logged, or the sink can't publish. Write a test entry. If it isn't here within a minute, run the setup script again.",
			],
			action: gcpCommand(
				h,
				model,
				`test-${connector.id}`,
				`gcloud logging write maple-test "hello from Maple" --project=${connector.project_id}`,
			),
		})
	if (metrics.kind === "waiting" && metrics.overdue)
		issues.push({
			key: "metrics-overdue",
			tone: "warn",
			title: "No metrics have arrived yet",
			body: [RETRIES],
		})
	if (metrics.kind === "receiving" && metrics.resourcesError !== null)
		issues.push({
			key: "resources",
			tone: "warn",
			title: "Resource list incomplete",
			body: [gcpMessage(h, metrics.resourcesError)],
		})
	if (issues.length > 0) return issues
	if (gcpSetupRunning(connector, nowMs))
		return [
			{
				key: "running",
				tone: "info",
				title: "Setup in progress",
				body: ["Logs and metrics start once it is complete."],
			},
		]
	if (log.kind === "waiting" || metrics.kind === "waiting")
		return [
			{
				key: "waiting",
				tone: "info",
				title: "Waiting for the first data",
				body: [
					log.kind === "waiting"
						? "Google Cloud usually starts sending within 10 minutes. Logs written before then aren't forwarded."
						: "The first metrics arrive within about 10 minutes.",
				],
			},
		]
	return []
}

type Signal = Readonly<{ tone: Tone; text: Html | string }>

/** A capability's state in a word or two, with when it last delivered. */
const signalText = (
	h: H,
	model: Model,
	timeZone: string,
	capability: GcpCapability,
	log: LogState,
	metrics: MetricsState,
): Signal => {
	const ago = (value: string, prefix?: string) =>
		relativeTime(h, { value, nowMs: model.nowMs, timeZone, prefix })
	if (capability === "logs") {
		switch (log.kind) {
			case "off":
				return { tone: "neutral", text: "Off" }
			case "failing":
				return {
					tone: "crit",
					text:
						log.lastLogReceivedAt === null
							? "Rejected"
							: ago(log.lastLogReceivedAt, "Rejected · last entry"),
				}
			case "setup-pending":
			case "setup-running":
				return { tone: "neutral", text: GCP_LOG_STATUS[log.kind].label }
			case "waiting":
				return log.overdue
					? { tone: "warn", text: "No entries in 20 minutes" }
					: { tone: "neutral", text: "No entries yet" }
			case "idle":
				return {
					tone: "neutral",
					text: ago(log.lastLogReceivedAt, "Nothing in 24 hours · last entry"),
				}
			case "receiving":
				return { tone: "ok", text: ago(log.lastLogReceivedAt, "Last entry") }
		}
	}
	switch (metrics.kind) {
		case "off":
			return { tone: "neutral", text: "Off" }
		case "setup-pending":
		case "setup-running":
			return { tone: "neutral", text: GCP_METRICS_STATUS[metrics.kind].label }
		case "waiting":
			return { tone: metrics.overdue ? "warn" : "neutral", text: "No reads yet" }
		case "failing":
			return {
				tone: "crit",
				text:
					metrics.lastMetricsReceivedAt === null
						? "Can't be read"
						: ago(metrics.lastMetricsReceivedAt, "Can't be read · last read"),
			}
		case "incomplete":
		case "stalled":
			return {
				tone: "warn",
				text: ago(
					metrics.lastMetricsReceivedAt,
					`${GCP_METRICS_STATUS[metrics.kind].label} · last read`,
				),
			}
		case "receiving":
			return { tone: "ok", text: ago(metrics.lastMetricsReceivedAt, "Last read") }
	}
}

const SIGNAL_LINK =
	"inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground active:text-foreground"

const signalView = (h: H, name: string, signal: Signal, link: Html | undefined): Html =>
	h.div(
		[h.Class("flex min-w-0 flex-1 flex-col gap-1 px-4 py-3")],
		[
			h.span([h.Class("text-xs font-medium")], [name]),
			h.span([h.Class(cn("text-xs/[18px]", TONE_TEXT[signal.tone]))], [signal.text]),
			...(link === undefined ? [] : [h.div([h.Class("pt-1")], [link])]),
		],
	)

const fact = (h: H, label: string, value: Html | string): Html =>
	h.div(
		[h.Class("flex w-36 shrink-0 flex-col gap-0.5")],
		[
			h.span([h.Class("text-2xs text-muted-foreground")], [label]),
			h.span([h.Class("truncate text-xs")], [value]),
		],
	)

const signalLink = (h: H, href: string, label: string): Html =>
	h.a([h.Href(href), h.Class(SIGNAL_LINK)], [label, icon(h, "ArrowRightIcon", { size: 12 })])

const menuEntries: ReadonlyArray<MenuEntry> = [
	...(IS_ADMIN ? [{ _tag: "Item", value: "configure", label: "Edit data" } as const] : []),
	{ _tag: "Item", value: "logs", label: "View logs" },
	{ _tag: "Item", value: "infra", label: "View infrastructure" },
	...(IS_ADMIN
		? [
				{ _tag: "Separator" } as const,
				{ _tag: "Item", value: "disconnect", label: "Disconnect", variant: "destructive" } as const,
			]
		: []),
]

export const gcpConnection = (h: H, model: Model, connector: V2GcpConnector, timeZone: string): Html => {
	const label = gcpScopeLabel(connector)
	const log = gcpLogState(connector, model.nowMs)
	const metrics = gcpMetricsState(connector, model.nowMs)
	const issues = connectionIssues(h, model, connector, log, metrics)
	const lastLog = log.kind === "receiving" || log.kind === "idle" ? log.lastLogReceivedAt : null
	const lastRead = "lastMetricsReceivedAt" in metrics ? metrics.lastMetricsReceivedAt : null
	const projects =
		metrics.kind === "receiving" && metrics.projectCount !== null
			? countLabel(metrics.projectCount, "project")
			: null
	const collects = [connector.logs_enabled ? "Logs" : null, connector.metrics_enabled ? "metrics" : null]
		.filter((part) => part !== null)
		.join(" and ")
	const name = h.div(
		[h.Class("flex min-w-0 items-center gap-2.5")],
		[
			h.h3([h.Class("truncate font-mono text-sm font-medium"), h.Title(label)], [connector.scope_id]),
			badge(h, { variant: "meta", size: "xs" }, [GCP_SCOPE_NAMES[connector.scope_type]]),
		],
	)
	const subtitle = [
		collects === "" ? "Collects nothing" : collects.charAt(0).toUpperCase() + collects.slice(1),
		projects,
		connector.scope_type === "project" ? null : `host ${connector.project_id}`,
	]
		.filter((part) => part !== null)
		.join(" · ")
	const menuId = `gcp-connection-menu-${connector.id}`
	const menu = rowActionsMenu(h, {
		slotId: menuId,
		model: model.gcpCard.menus[menuId] ?? Menu.init(menuId),
		label: `Actions for ${label}`,
		entries: menuEntries,
		toParentMessage: (message) => Message.GotGcpMenuMessage({ id: connector.id, message }),
	})
	const ago = (value: string) => relativeTime(h, { value, nowMs: model.nowMs, timeZone })
	// The same row in every state: dot, name and kind, subtitle. Issues add their notes below it.
	const nameRow = (tone: Issue["tone"] | "ok") =>
		h.div(
			[h.Class("flex min-w-0 flex-1 basis-56 items-start gap-2.5")],
			[
				h.span(
					[h.Class("flex h-5 w-3.5 shrink-0 items-center justify-center")],
					[statusDot(h, { tone: dotTone(tone), size: "lg" })],
				),
				h.div(
					[h.Class("flex min-w-0 flex-col gap-0.5")],
					[name, h.p([h.Class("truncate text-xs text-muted-foreground")], [subtitle])],
				),
			],
		)
	if (issues.length === 0)
		return panel(h, { className: "@container" }, [
			h.div(
				[h.Class("flex flex-wrap items-center gap-x-6 gap-y-2 py-3 pr-2 pl-4")],
				[
					nameRow("ok"),
					h.div(
						[
							h.Class(
								"order-last flex basis-full gap-6 pl-6 @2xl:order-none @2xl:basis-auto @2xl:pl-0",
							),
						],
						[
							fact(h, "Last log", lastLog === null ? "Off" : ago(lastLog)),
							fact(h, "Last metrics", lastRead === null ? "Off" : ago(lastRead)),
						],
					),
					menu,
				],
			),
		])
	return panel(h, { className: "@container" }, [
		h.div(
			[h.Class("flex flex-col gap-3 pt-3 pr-2 pb-4 pl-4")],
			[
				h.div(
					[h.Class("flex items-center justify-between gap-3")],
					[nameRow(issues[0]?.tone ?? "info"), h.div([h.Class("shrink-0")], [menu])],
				),
				h.div(
					[h.Class("flex flex-col gap-3 pr-2")],
					issues.map((issue) => issueNote(h, issue, issues.length > 1)),
				),
			],
		),
		h.div(
			[
				h.Class(
					"flex flex-col divide-y divide-border-subtle border-t border-border-subtle @md:flex-row @md:divide-x @md:divide-y-0",
				),
			],
			[
				signalView(
					h,
					"Logs",
					signalText(h, model, timeZone, "logs", log, metrics),
					lastLog === null ? undefined : signalLink(h, gcpLogsHref(connector), "View logs"),
				),
				signalView(
					h,
					"Metrics",
					signalText(h, model, timeZone, "metrics", log, metrics),
					lastRead === null
						? undefined
						: signalLink(h, gcpInfraHref(connector), "View infrastructure"),
				),
			],
		),
	])
}
