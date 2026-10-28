import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { docsUrl } from "../../../lib/docs"
import { ingestUrl } from "../../../lib/services/common/ingest-url"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { INLINE_LINK_CLASS, settingsSection, settingsSections } from "../kit/section"
import * as MappingDialogView from "./mapping-dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import { credentialRow, ingestKeyRows } from "./view-keys"
import { connectInstructions, frameworkIconStrip, frameworkPicker } from "./view-setup"
import { deleteMappingDialog, mappingsSection, recommendationsSection } from "./view-rules"

// `IngestionSection`.

type H = HtmlBuilder<Message>

/** `useIngestConnection`: the org's own (non-`demo-`) services and their span rate. */
const connectionOf = (model: Model) => {
	const rows = AsyncData.getOrElse(model.overview, () => [])
	const real = rows.filter((row) => !row.serviceName.startsWith("demo-"))
	return {
		isConnected: real.length > 0,
		serviceCount: real.length,
		spansPerMinute: real.reduce((sum, row) => sum + row.spanCount, 0) / 60,
		privateKey: AsyncData.getOrElse(
			AsyncData.map(model.ingest, (keys) => keys.private_key),
			() => "",
		),
	}
}

/** The status read failed with nothing shown yet: no claim either way about telemetry. */
const unknownStatusBanner = (h: H): Html =>
	panel(h, { className: "flex-row items-center gap-3 px-4 py-2.5" }, [
		statusDot(h, { tone: "neutral", size: "lg" }),
		h.span([h.Class("text-sm font-medium whitespace-nowrap")], ["Status unknown"]),
		h.span(
			[h.Class("truncate font-prose text-xs text-muted-foreground")],
			["Couldn't check for incoming telemetry."],
		),
	])

const statusBanner = (h: H, model: Model): Html => {
	if (AsyncData.isFailure(model.overview)) return unknownStatusBanner(h)
	const connection = connectionOf(model)
	const spansPerMinute = Math.round(connection.spansPerMinute)
	return panel(h, { className: "flex-row items-center gap-3 px-4 py-2.5" }, [
		connection.isConnected
			? statusDot(h, { tone: "ok", size: "lg" })
			: icon(h, "PulseIcon", { size: 12, className: "text-primary shrink-0" }),
		h.span(
			[h.Class("text-sm font-medium whitespace-nowrap")],
			[connection.isConnected ? "Receiving telemetry" : "Waiting for telemetry"],
		),
		h.span(
			[h.Class("text-muted-foreground truncate font-mono text-xs")],
			[
				connection.isConnected
					? [
							countLabel(connection.serviceCount, "service"),
							spansPerMinute > 0 ? `${formatNumber(spansPerMinute)} spans/min` : null,
						]
							.filter((part) => part !== null)
							.join(" · ")
					: "watching for your first trace",
			],
		),
		h.div([h.Class("grow")], []),
		...(connection.isConnected
			? [
					h.a(
						[
							h.Href("/traces"),
							h.Class(
								cn(
									buttonVariants({
										variant: "ghost",
										size: "sm",
										className: "text-muted-foreground hover:text-foreground gap-1.5",
									}),
								),
							),
							h.DataAttribute("slot", "button"),
						],
						["Explore traces", icon(h, "ArrowRightIcon")],
					),
				]
			: []),
	])
}

/** The OTLP endpoint plus the org's ingest key pair. The pair is admin-only, so members see the endpoint. */
const endpointAndKeysSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "ingestion-endpoint-heading",
			title: model.isAdmin ? "Endpoint & keys" : "Endpoint",
			description: ["Point your OTLP exporter at the endpoint and authenticate with an ingest key."],
			padded: false,
			actions: h.a(
				[
					h.Href(docsUrl("instrumentation")),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.Class(
						cn("inline-flex items-center gap-1 text-xs whitespace-nowrap", INLINE_LINK_CLASS),
					),
				],
				["Docs", icon(h, "ExternalLinkIcon", { size: 12 })],
			),
		},
		[
			h.div(
				[h.Class("divide-y")],
				[
					credentialRow(h, {
						label: "OTLP endpoint",
						badge: "HTTP",
						badgeClass: "text-muted-foreground",
						value: ingestUrl,
						copy: model.endpointCopy,
						onCopy: (text) =>
							Message.GotEndpointCopyMessage({
								message: CopyButton.Message.ClickedCopy({ text }),
							}),
					}),
					...(model.isAdmin ? ingestKeyRows(h, model) : []),
					manageSourcesRow(h),
				],
			),
		],
	)

/** The pointer to `/sources` under the keys. */
const manageSourcesRow = (h: H): Html =>
	h.div(
		[h.Class("text-muted-foreground flex items-center gap-2 px-4 py-2.5 text-xs")],
		[
			icon(h, "ConnectionIcon", { size: 12, className: "shrink-0" }),
			h.span([h.Class("grow font-prose")], ["Give each sender its own token, rules and pause switch."]),
			h.a(
				[
					h.Href("/sources"),
					h.Class(
						"text-foreground inline-flex items-center gap-1 hover:underline underline-offset-2",
					),
				],
				["Manage sources", icon(h, "ChevronRightIcon", { size: 12 })],
			),
		],
	)

const rollKeyDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: "ingestion-key-roll-dialog",
		model: model.rollDialog,
		toParentMessage: (message) => Message.GotRollDialogMessage({ message }),
		title: `Regenerate ${model.rollType} key?`,
		description: [
			"This action cannot be undone. All existing integrations using this key will stop working immediately. You will need to update your",
			" ",
			model.rollType === "public" ? "client-side SDKs" : "server configurations",
			" with the new key.",
		],
		confirmLabel: "Regenerate key",
		onConfirm: Message.ClickedConfirmRoll(),
		isPending: model.isRolling,
	})

const addServiceSection = (h: H, model: Model): Html => {
	const connection = connectionOf(model)
	const isOpen = !connection.isConnected || model.isSetupExpanded
	return settingsSection(
		h,
		{
			id: "ingestion-add-service-heading",
			title: connection.isConnected ? "Add another service" : "Send your first telemetry",
			description: [
				connection.isConnected
					? "Install steps for a new service, or let Claude Code wire it up for you."
					: "Point your OpenTelemetry SDK at Maple, or let Claude Code wire it up for you.",
			],
			padded: false,
		},
		[
			isOpen
				? h.div(
						[],
						[
							// Its own wrapping row, so the chips never crowd the section heading.
							h.div([h.Class("border-b px-4 py-3")], [frameworkPicker(h, model.framework)]),
							connectInstructions(h, model, connection.privateKey),
						],
					)
				: h.div(
						[h.Class("flex items-center gap-3 px-4 py-3")],
						[
							frameworkIconStrip(h),
							h.span(
								[h.Class("text-muted-foreground min-w-0 grow truncate text-xs")],
								["Next.js, Node.js, Python, Go, Effect and more"],
							),
							button(
								h,
								{
									variant: "outline",
									size: "sm",
									attributes: [h.OnClick(Message.ClickedShowSetup())],
								},
								[
									"Show setup",
									icon(h, "ChevronRightIcon", {
										attributes: [h.DataAttribute("icon", "inline-end")],
									}),
								],
							),
						],
					),
		],
	)
}

/** The tab takes everything from its Model. */
type NoInputs = Readonly<{ readonly none?: never }>

export const view = Submodel.defineView<Model, Message, NoInputs>((model, _inputs, h) =>
	settingsSections(h, [
		// `AdminOnlyNotice subject="ingestion settings"` renders nothing for admins.
		statusBanner(h, model),
		endpointAndKeysSection(h, model),
		addServiceSection(h, model),
		...recommendationsSection(h, model),
		mappingsSection(h, model),
		h.submodel({
			slotId: "ingestion-mapping-dialog",
			model: model.mappingDialog,
			view: MappingDialogView.view,
			toParentMessage: (message) => Message.GotMappingDialogMessage({ message }),
			viewInputs: { slotId: "ingestion-mapping-dialog-popup" },
		}),
		deleteMappingDialog(h, model),
		...(model.isAdmin ? [rollKeyDialog(h, model)] : []),
	]),
)
