import { countLabel, formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { docsUrl } from "@maple/web/lib/docs"
import { ingestUrl } from "@maple/web/lib/services/common/ingest-url"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { statusDot } from "../../../ui/status-dot"
import { settingsSection, settingsSections } from "../kit/section"
import * as MappingDialogView from "./mapping-dialog-view"
import { Message } from "./message"
import type { Model } from "./model"
import { connectInstructions, frameworkIconStrip, frameworkPicker } from "./view-setup"
import { deleteMappingDialog, mappingsSection, recommendationsSection } from "./view-rules"

// `IngestionSection` (apps/web/src/components/settings/ingestion-section.tsx).

type H = HtmlBuilder<Message>

/** `useIngestConnection`: the org's own (non-`demo-`) services and their span rate. */
const connectionOf = (model: Model) => {
	const rows = AsyncData.getOrElse(model.overview, () => [])
	const real = rows.filter((row) => !row.serviceName.startsWith("demo-"))
	return {
		isConnected: real.length > 0,
		serviceCount: real.length,
		spansPerMinute: real.reduce((sum, row) => sum + row.spanCount, 0) / 60,
		publicKey: AsyncData.getOrElse(AsyncData.map(model.ingest, (keys) => keys.public_key), () => ""),
		privateKey: AsyncData.getOrElse(AsyncData.map(model.ingest, (keys) => keys.private_key), () => ""),
	}
}

const statusBanner = (h: H, model: Model): Html => {
	const connection = connectionOf(model)
	const spansPerMinute = Math.round(connection.spansPerMinute)
	return panel(h, { className: "flex-row items-center gap-3 px-4 py-2.5" }, [
		connection.isConnected
			? statusDot(h, { tone: "ok", size: "lg" })
			: icon(h, "PulseIcon", { size: 12, className: "text-primary shrink-0" }),
		h.span([h.Class("text-sm font-medium whitespace-nowrap")], [connection.isConnected ? "Receiving telemetry" : "Waiting for telemetry"]),
		h.span(
			[h.Class("text-muted-foreground truncate font-mono text-xs")],
			[
				connection.isConnected
					? [countLabel(connection.serviceCount, "service"), spansPerMinute > 0 ? `${formatNumber(spansPerMinute)} spans/min` : null]
							.filter((part) => part !== null)
							.join(" · ")
					: "watching for your first trace",
			],
		),
		h.div([h.Class("grow")], []),
		connection.isConnected
			? h.a(
					[
						h.Href("/traces"),
						h.Class(cn(buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground hover:text-foreground gap-1.5" }))),
						h.DataAttribute("slot", "button"),
					],
					["Explore traces", icon(h, "ArrowRightIcon")],
				)
			: button(
					h,
					{
						variant: "outline",
						size: "sm",
						className: "shrink-0 gap-2",
						isLoading: model.isSendingTest,
						isDisabled: connection.publicKey === "",
						attributes: [h.OnClick(Message.ClickedSendTestEvent())],
					},
					[icon(h, "PaperPlaneIcon"), "Send test event"],
				),
	])
}

const endpointSection = (h: H, model: Model): Html =>
	settingsSection(
		h,
		{
			id: "ingestion-endpoint-heading",
			title: "Endpoint",
			padded: false,
			actions: h.a(
				[
					h.Href(docsUrl("instrumentation")),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.Class("text-muted-foreground hover:text-foreground font-mono text-2xs whitespace-nowrap transition-colors"),
				],
				["Setup docs ↗"],
			),
		},
		[
			h.div(
				[h.Class("divide-y")],
				[
					h.div(
						[h.Class("flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3 sm:flex-nowrap")],
						[
							h.span([h.Class("shrink-0 text-sm sm:w-[120px]")], ["OTLP endpoint"]),
							eyebrow(h, { variant: "mono", className: "text-muted-foreground hidden w-14 shrink-0 sm:block" }, ["HTTP"]),
							h.span([h.Class("min-w-0 grow truncate font-mono text-xs")], [ingestUrl]),
							CopyButton.view(h, {
								model: model.endpointCopy,
								toParentMessage: (message) => Message.GotEndpointCopyMessage({ message }),
								value: ingestUrl,
								label: "OTLP endpoint",
								variant: "outline",
								size: "icon-sm",
							}),
						],
					),
					h.div(
						[h.Class("text-muted-foreground flex items-center gap-2 px-4 py-2.5 text-xs")],
						[
							icon(h, "KeyIcon", { size: 12, className: "shrink-0" }),
							h.span([h.Class("grow")], ["Ingest keys live in Keys."]),
							h.a(
								[h.Href("/settings?tab=keys"), h.Class("text-foreground inline-flex items-center gap-1 hover:underline underline-offset-2")],
								["Open Keys", icon(h, "ChevronRightIcon", { size: 12 })],
							),
						],
					),
				],
			),
		],
	)

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
			actions: isOpen ? frameworkPicker(h, model.framework) : undefined,
		},
		[
			isOpen
				? connectInstructions(h, model, connection.privateKey)
				: h.div(
						[h.Class("flex items-center gap-3 px-4 py-3")],
						[
							frameworkIconStrip(h),
							h.span([h.Class("text-muted-foreground min-w-0 grow truncate text-xs")], ["Next.js, Node.js, Python, Go, Effect and more"]),
							button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedShowSetup())] }, [
								"Show setup",
								icon(h, "ChevronRightIcon", { attributes: [h.DataAttribute("icon", "inline-end")] }),
							]),
						],
					),
		],
	)
}

/** The tab takes everything from its Model. */
type NoInputs = Readonly<{ readonly none?: never }>

export const view = Submodel.defineView<Model, Message, NoInputs>((model, _inputs, h) =>
	settingsSections(h, "standard", [
		// `AdminOnlyNotice subject="ingestion settings"` renders nothing for admins.
		statusBanner(h, model),
		endpointSection(h, model),
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
	]),
)
