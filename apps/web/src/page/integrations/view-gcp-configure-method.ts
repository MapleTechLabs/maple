import { gcpSetupPlan } from "@maple/domain/gcp"
import type { V2GcpConnector, V2GcpSetupScripts } from "@maple/domain/http/v2"
import { gcpLogFilterChoice, gcpNothingSeen } from "../../components/integrations/gcp-connector-state"
import { gcpAgentPrompt, gcpManualSteps, gcpRemovalList } from "../../components/integrations/gcp-setup-steps"
import { isUnexpectedError } from "@maple/web-data/lib/error-messages"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { heading } from "../../ui/heading"
import { button } from "../../ui/button"
import { skeleton } from "../../ui/skeleton"
import { IAC_DOCS, MANUAL_DOCS } from "./gcp-configure-copy"
import type { ApplyOpened, ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { filterShort } from "./view-gcp-configure-filter"
import { methodChoice } from "./view-gcp-configure-method-choice"
import {
	configureFooter,
	configureHeader,
	configurePanel,
	externalLink,
	footerNote,
	mono,
} from "./view-gcp-configure-parts"
import { runAs, runSummary } from "./view-gcp-configure-run"
import { fileCard, loadFailure } from "./view-gcp-configure-script"
import { runStatus } from "./view-gcp-configure-status"
import { type ScriptFailure, SMALL } from "./view-gcp-parts"
import { manualSteps, removalItem } from "./view-gcp-setup-methods"

// `GcpMethodStage` and `GcpMethodApplyView`: how Google Cloud is set up, and the setup without the script.

type H = HtmlBuilder<Message>
type Children = ReadonlyArray<Html | string>

/** The Method step: UI only, nothing is saved. */
export const methodStage = (
	h: H,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	title: Children,
): ReadonlyArray<Html> => {
	const choice = gcpLogFilterChoice(configure.filter, connector.applied_logs_enabled === true)
	const nothingSeen = gcpNothingSeen(connector)
	return [
		configureHeader(h, title, 2),
		configurePanel(
			h,
			[runSummary(h, connector, filterShort(choice), false), methodChoice(h, configure, !nothingSeen)],
			"flex flex-col gap-5",
		),
		configureFooter(h, [
			footerNote(h, [
				nothingSeen
					? "Each method creates the same resources."
					: "Each method makes the same change.",
			]),
			button(h, { variant: "outline", attributes: [h.OnClick(Message.ClickedGcpRunEdit())] }, ["Back"]),
			button(h, { attributes: [h.OnClick(Message.ClickedGcpMethodContinue())] }, ["Continue"]),
		]),
	]
}

/** `useGcpScripts` for the setup: only a settled read counts, as a held-over one is for another filter. */
const setupState = (
	configure: ConfigureModel,
): { setup: V2GcpSetupScripts | null; failure: ScriptFailure | null } => {
	const data = configure.scripts.data
	if (AsyncData.isSuccess(data)) return { setup: data.data, failure: null }
	if (AsyncData.isFailure(data))
		return {
			setup: null,
			failure: {
				message: isUnexpectedError(data.error) ? "Couldn't load the script." : data.error.message,
				isRetrying: false,
			},
		}
	return { setup: null, failure: null }
}

/** A file removes only what it created: what a script or the console made is deleted by hand. */
const removalSection = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	isCode: boolean,
): ReadonlyArray<Html> => {
	const removal = gcpRemovalList(connector)
	if (removal.length === 0) return []
	// Parts Maple never saw working may not exist: listed, but there is nothing to confirm.
	const confirmable = removal.some((item) => item.confirmed)
	return [
		h.section(
			[h.Class("flex flex-col gap-3")],
			[
				h.div(
					[h.Class("flex flex-col gap-0.5")],
					[
						heading(
							h,
							{ level: 3, variant: "subsection" },
							[
								isCode
									? "If your file didn't create these, delete them in the console"
									: confirmable
										? "Delete these in the Google Cloud console"
										: "If you created these, delete them in the console",
							],
						),
						h.p(
							[h.Class(SMALL)],
							[
								"In this order: Google keeps routing to the topic for a while.",
								" ",
								externalLink(h, `${MANUAL_DOCS}#removing`, "Details"),
							],
						),
					],
				),
				h.ol(
					[h.Class("flex list-decimal flex-col gap-2 pl-5 text-xs/5")],
					removal.map((item) => removalItem(h, model, item)),
				),
				...(confirmable
					? [
							h.div(
								[h.Class("flex flex-wrap items-center justify-between gap-x-4 gap-y-2")],
								[
									h.p(
										[h.Class(SMALL)],
										["Maple can't see a removal. Tell it once it is done."],
									),
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											isLoading: configure.isConfirmingRemoval,
											attributes: [h.OnClick(Message.ClickedGcpConfirmRemoval())],
										},
										["I've removed them"],
									),
								],
							),
						]
					: []),
			],
		),
	]
}

type Plan = ReturnType<typeof gcpSetupPlan>

const manualBody = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	state: Readonly<{ plan: Plan | null; failure: ScriptFailure | null }>,
): ReadonlyArray<Html> => {
	const { plan, failure } = state
	const steps =
		failure !== null
			? [loadFailure(h, failure)]
			: plan === null
				? [skeleton(h, "h-60 w-full")]
				: plan.logs === null && plan.reader === null
					? []
					: [
							manualSteps(h, model, configure, {
								heading: "Create these in the Google Cloud console",
								detail:
									connector.scope_type === "project"
										? `In ${connector.project_id}. Names are generated for this connection.`
										: `Resources go in ${connector.project_id}; the sink and read-only roles on the ${connector.scope_type}.`,
								steps: gcpManualSteps(plan),
								docsHref: MANUAL_DOCS,
							}),
						]
	return [...removalSection(h, model, configure, connector, false), ...steps]
}

const codeBody = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	state: Readonly<{ plan: Plan | null; setup: V2GcpSetupScripts | null; failure: ScriptFailure | null }>,
): Html => {
	const isTerraform = configure.method === "terraform"
	const iac = isTerraform ? "tf" : "ts"
	const config = state.setup === null ? null : isTerraform ? state.setup.terraform : state.setup.alchemy
	const flavour = isTerraform ? "terraform" : "alchemy"
	const removing = gcpRemovalList(connector).length > 0
	return h.section(
		[h.Class("flex flex-col gap-3")],
		[
			h.div(
				[h.Class("flex flex-col gap-0.5")],
				[
					heading(
						h,
						{ level: 3, variant: "subsection" },
						[
							isTerraform
								? "Add this to your Terraform configuration"
								: "Add this to your Alchemy app",
						],
					),
					h.p(
						[h.Class(SMALL)],
						[
							removing
								? `Replace your earlier maple.${iac} with this version: applying it removes what that one created and this one no longer has.`
								: `Same resources as the script. Nothing changes in Google Cloud until you ${isTerraform ? "apply" : "deploy"}.`,
						],
					),
				],
			),
			fileCard(h, model, configure, {
				name: `maple.${iac}`,
				text: config,
				failure: state.failure,
				secret: false,
				prompt:
					state.plan === null || config === null
						? null
						: gcpAgentPrompt({ flavour, config, plan: state.plan, connector }),
			}),
			h.p(
				[h.Class(SMALL)],
				[
					...(isTerraform
						? ["Apply with ", mono(h, "terraform apply"), " ", ...runAs(h, connector)]
						: [
								"Deploy with the command in the file's header",
								" ",
								...runAs(h, connector),
								...(connector.logs_enabled
									? [" Fill in PROJECT_NUMBER at the top first."]
									: []),
							]),
					" ",
					externalLink(h, IAC_DOCS, "Details"),
				],
			),
			...removalSection(h, model, configure, connector, true),
		],
	)
}

/** The console steps or the Terraform/Alchemy file, for a setup without the script. */
export const methodSetup = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
): ReadonlyArray<Html> => {
	const { setup, failure } = setupState(configure)
	const plan =
		setup === null
			? null
			: gcpSetupPlan({
					connectorId: connector.id,
					scopeType: connector.scope_type,
					scopeId: connector.scope_id,
					projectId: connector.project_id,
					pushEndpoint: setup.push_endpoint,
					mapleServiceAccountEmail: setup.maple_service_account_email ?? undefined,
					logsEnabled: connector.logs_enabled,
					metricsEnabled: connector.metrics_enabled,
					logFilter: setup.log_filter,
				})
	return configure.method === "manual"
		? manualBody(h, model, configure, connector, { plan, failure })
		: [codeBody(h, model, configure, connector, { plan, setup, failure })]
}

/** The Set up step without the script: the console steps or the file, always, and what Maple has confirmed. */
export const methodApplyStage = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	options: Readonly<{ title: Children; opened: ApplyOpened }>,
): ReadonlyArray<Html> => {
	const choice = gcpLogFilterChoice(configure.filter, configure.sinkExisted)
	// Without the script there is no filter to keep.
	const logFilter = choice.keep ? "Recommended filter, replaces the current one" : filterShort(choice)
	return [
		configureHeader(h, options.title, 3),
		configurePanel(
			h,
			[
				runSummary(h, connector, logFilter, false),
				...(choice.keep && connector.logs_enabled
					? [
							h.p(
								[h.Class(SMALL)],
								[
									"Sets the recommended filter. If you customised the sink's filter, paste yours instead.",
								],
							),
						]
					: []),
				...methodSetup(h, model, configure, connector),
			],
			"flex flex-col gap-5",
		),
		runStatus(h, connector, {
			opened: options.opened,
			overdue: false,
			nowMs: model.nowMs,
			method: configure.method,
		}),
		configureFooter(h, [
			footerNote(h, ["Saved. Close this any time and come back to it."]),
			button(h, { variant: "outline", attributes: [h.OnClick(Message.ClosedGcpConfigure())] }, [
				"Close",
			]),
		]),
	]
}
