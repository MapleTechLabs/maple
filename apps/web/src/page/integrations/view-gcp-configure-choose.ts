import type { V2GcpConnector } from "@maple/domain/http/v2"
import { GCP_SCOPE_NAMES, logRouterUrl } from "../../components/integrations/gcp-connector-state"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { confirmDialog } from "../../ui/confirm-dialog"
import { CAPABILITIES } from "./gcp-configure-copy"
import { chooseChanges } from "./gcp-configure-derive"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import { collectFields } from "./view-gcp-configure-collect"
import { logFilter } from "./view-gcp-configure-filter"
import { configureFooter, configureHeader, configurePanel, footerNote } from "./view-gcp-configure-parts"

// `ChooseStage`: a connection's data step, and the confirmation for a change that acts at once.

type H = HtmlBuilder<Message>
type Changes = ReturnType<typeof chooseChanges>

export const chooseStage = (
	h: H,
	configure: ConfigureModel,
	connector: V2GcpConnector,
	options: Readonly<{
		title: ReadonlyArray<Html | string>
		metricsAvailable: boolean
		close: ReadonlyArray<ChildAttribute>
	}>,
): ReadonlyArray<Html> => {
	const changes = chooseChanges(connector, configure.chooseFlags)
	const { changed, scripted } = changes
	const saving = configure.isSaving
	const confirming = configure.confirm.isOpen
	return [
		configureHeader(h, options.title, 1),
		configurePanel(h, [
			collectFields(h, {
				flags: configure.chooseFlags,
				metricsAvailable: options.metricsAvailable,
				effect: changes.effect,
				logFilter: logFilter(h, configure, {
					sinkExists: connector.applied_logs_enabled === true,
					logRouter: logRouterUrl(connector),
				}),
			}),
		]),
		configureFooter(h, [
			...(changed.length > 0 && !scripted
				? [footerNote(h, ["Nothing to run after this: Google Cloud still has what it needs."])]
				: []),
			button(
				h,
				{
					variant: "outline",
					isDisabled: saving,
					slot: "dialog-close",
					attributes: saving ? [] : options.close,
				},
				["Cancel"],
			),
			button(
				h,
				{
					isLoading: saving && !confirming,
					attributes: [h.OnClick(Message.ClickedGcpChooseApply())],
				},
				[changed.length === 0 ? "Continue" : scripted ? "Save and continue" : "Save"],
			),
		]),
	]
}

/** Rendered beside the wizard's dialog, not in it: each portal moves itself to `<body>`. */
export const chooseConfirm = (h: H, configure: ConfigureModel, connector: V2GcpConnector): Html =>
	confirmSave(h, configure, connector, chooseChanges(connector, configure.chooseFlags))

const named = (list: Changes["immediate"]): string =>
	list.map(({ capability }) => CAPABILITIES[capability].title.toLowerCase()).join(" and ")

/** One save can turn one capability off and the other back on: the question names both. */
const confirmSave = (h: H, configure: ConfigureModel, connector: V2GcpConnector, changes: Changes): Html => {
	const { immediate, stopping, resuming } = changes
	const turned = [
		stopping.length > 0 ? `${named(stopping)} off` : null,
		resuming.length > 0 ? `${named(resuming)} back on` : null,
	]
		.filter((part) => part !== null)
		.join(" and ")
	const list = (term: string, lines: ReadonlyArray<string>): Html =>
		h.div(
			[],
			[
				h.dt([h.Class("font-medium")], [term]),
				...lines.map((line) => h.dd([h.Class("text-pretty text-muted-foreground")], [line])),
			],
		)
	return confirmDialog(h, {
		slotId: "gcp-configure-confirm",
		model: configure.confirm,
		toParentMessage: (message) => Message.GotGcpConfirmDialogMessage({ message }),
		isNested: true,
		tone: stopping.length > 0 ? "destructive" : "default",
		hasIcon: stopping.length > 0,
		title: [
			`Turn ${turned}`,
			" for ",
			GCP_SCOPE_NAMES[connector.scope_type],
			" ",
			h.span([h.Class("whitespace-nowrap")], [connector.scope_id]),
			"?",
		],
		// Turning off leaves something for the script to remove; turning back on leaves nothing to run.
		confirmLabel:
			stopping.length === 0
				? "Turn on"
				: resuming.length === 0
					? "Turn off and continue"
					: "Save and continue",
		onConfirm: Message.ConfirmedGcpSave(),
		isPending: configure.isSaving,
		children: [
			h.dl(
				[h.Class("flex flex-col gap-3 pb-3 text-sm")],
				[
					list(
						"In Maple",
						immediate.map(({ capability, acts }) => CAPABILITIES[capability].now[acts]),
					),
					list(
						"In Google Cloud",
						immediate.map(({ capability, acts }) => CAPABILITIES[capability].later[acts]),
					),
				],
			),
		],
	})
}
