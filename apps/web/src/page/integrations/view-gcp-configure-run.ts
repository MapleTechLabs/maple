import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	GCP_SCOPE_NAMES,
	gcpLogFilterChoice,
	gcpScopeRoles,
	gcpScriptOverdue,
} from "../../components/integrations/gcp-connector-state"
import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../ui/heading"
import { button } from "../../ui/button"
import { relativeTime } from "../kit/relative-time"
import { DOCS } from "./gcp-configure-copy"
import { runConfirmed } from "./gcp-configure-derive"
import type { ApplyOpened, ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { filterShort } from "./view-gcp-configure-filter"
import {
	chip,
	configureFooter,
	configureHeader,
	configurePanel,
	externalLink,
	footerNote,
	mono,
} from "./view-gcp-configure-parts"
import { fileCard } from "./view-gcp-configure-script"
import { applied, runStatus } from "./view-gcp-configure-status"
import { openCloudShellButton, type ScriptFailure, SMALL } from "./view-gcp-parts"

// `ApplyStage` / `GcpApplyView`: the script and the run's status, or the confirmed run.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>

/** What the script applies, so it is never a black box, and the way back to change it. */
export const runSummary = (h: H, connector: V2GcpConnector, logFilter: string, byScript = true): Html => {
	const removed = byScript ? "removed by this run" : "to remove"
	const capabilities = [
		connector.logs_enabled
			? `Logs · ${logFilter}`
			: connector.applied_logs_enabled === true
				? `Logs · ${removed}`
				: null,
		connector.metrics_enabled
			? "Metrics"
			: connector.applied_metrics_enabled === true
				? `Metrics · ${removed}`
				: null,
	].filter((label) => label !== null)
	return h.div(
		[h.Class("flex flex-wrap items-center gap-2")],
		[
			chip(h, [
				h.span([h.Class("text-muted-foreground")], [GCP_SCOPE_NAMES[connector.scope_type]]),
				h.span([h.Class("font-mono")], [connector.scope_id]),
			]),
			...(connector.scope_type === "project"
				? []
				: [
						chip(h, [
							h.span([h.Class("text-muted-foreground")], ["Host"]),
							h.span([h.Class("font-mono")], [connector.project_id]),
						]),
					]),
			...capabilities.map((label) => chip(h, [label])),
			button(
				h,
				{
					variant: "link",
					size: "xs",
					className: "ml-auto h-auto p-0",
					attributes: [h.OnClick(Message.ClickedGcpRunEdit())],
				},
				["Edit"],
			),
		],
	)
}

/** `RunAs`: who may run or apply a setup, an Owner of the host project with the scope's roles. */
export const runAs = (h: H, connector: V2GcpConnector): ReadonlyArray<Html | string> => {
	const scopeRoles = gcpScopeRoles(connector.scope_type, connector)
	const role = (name: string) => h.span([h.Class("text-foreground")], [name])
	return [
		"as an ",
		role("Owner"),
		" of ",
		...(connector.scope_type === "project" ? [] : ["the host project "]),
		mono(h, connector.project_id),
		...scopeRoles.flatMap((name, index) => [index === 0 ? " who also has " : " and ", role(name)]),
		...(scopeRoles.length > 0 ? [` on the ${connector.scope_type}`] : []),
		".",
	]
}

const scriptState = (configure: ConfigureModel): { script: string | null; failure: ScriptFailure | null } => {
	const data = configure.scripts.data
	// A held-over script is for the previous filter: only a settled result counts.
	if (AsyncData.isSuccess(data)) return { script: data.data.setup_script, failure: null }
	if (AsyncData.isFailure(data))
		return {
			script: null,
			failure: {
				message: isUnexpectedError(data.error) ? "Couldn't load the script." : data.error.message,
				isRetrying: false,
			},
		}
	return { script: null, failure: null }
}

/** The setup script with Copy and Open in Cloud Shell, and who may run it. */
export const scriptSection = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
): Html => {
	const sinkExists = connector.applied_logs_enabled === true
	const { script, failure } = scriptState(configure)
	return h.section(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-col gap-0.5")],
				[
					heading(h, { level: 3, variant: "subsection" }, ["Run this script in Cloud Shell"]),
					h.p([h.Class(SMALL)], ["Nothing changes in Google Cloud until it runs."]),
				],
			),
			fileCard(h, model, configure, {
				name: "setup.sh",
				text: script,
				failure,
				secret: true,
				children: [openCloudShellButton(h, connector.project_id, "default")],
			}),
			h.p(
				[h.Class(SMALL)],
				[
					"Run it ",
					...runAs(h, connector),
					" ",
					!connector.logs_enabled && sinkExists
						? "Takes one to two minutes. "
						: "Takes about a minute and is safe to run again. ",
					externalLink(h, `${DOCS}#roles-for-running-the-script`, "Roles if you aren't an Owner"),
				],
			),
		],
	)
}

export const applyStage = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	options: Readonly<{ title: Children; created: boolean; opened: ApplyOpened; timeZone: string }>,
): ReadonlyArray<Html> => {
	const { opened } = options
	const nowMs = model.nowMs
	const sinkExists = connector.applied_logs_enabled === true
	const reportedAt = connector.setup_reported_at
	const close = Message.ClosedGcpConfigure()
	if (runConfirmed(connector, opened, nowMs))
		return [
			configureHeader(h, options.title, null),
			configurePanel(h, [applied(h, connector, options.created, nowMs)]),
			configureFooter(h, [
				...(reportedAt === null
					? []
					: [
							footerNote(h, [
								relativeTime(h, {
									value: reportedAt,
									nowMs,
									timeZone: options.timeZone,
									prefix: "Setup finished",
								}),
							]),
						]),
				button(h, { attributes: [h.OnClick(close)] }, ["Done"]),
			]),
		]
	const overdue = !opened.rerun && gcpScriptOverdue(connector, opened.at, nowMs)
	const choice = gcpLogFilterChoice(configure.filter, sinkExists)
	return [
		configureHeader(h, options.title, 3),
		configurePanel(
			h,
			[runSummary(h, connector, filterShort(choice)), scriptSection(h, model, configure, connector)],
			"flex flex-col gap-5",
		),
		runStatus(h, connector, { opened, overdue, nowMs, method: "script" }),
		configureFooter(h, [
			footerNote(h, ["Saved. Close this any time and come back to it."]),
			button(h, { variant: "outline", attributes: [h.OnClick(close)] }, ["Close"]),
		]),
	]
}
