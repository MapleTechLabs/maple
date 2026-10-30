import { DOCS_LOCAL_MODE_SEND_TELEMETRY } from "../../lib/links"
import {
	copyableFieldInputStyles,
	copyableFieldLabelStyles,
	copyableFieldStyles,
} from "@maple/ui/styles/ui/copyable-field"
import type { CopyButtonViewInputs } from "@maple/web/ui/copy-button"
import { inputGroup, inputGroupAddon, inputGroupInput } from "@maple/web/ui/input-group"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type Copies, CopyMessage, copiesButton } from "./copies"

// The one "how to send telemetry here" block.

/** `otelEnvBlock`: `http/protobuf` spelled out, the server speaks OTLP over HTTP only. */
export const otelEnvBlock = (endpoint: string, serviceName = "my-service"): string =>
	[
		`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
		"OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		`OTEL_SERVICE_NAME=${serviceName}`,
	].join("\n")

/** Renders one copy button, by the id the guide gives it (`${id}-endpoint`, `${id}-env`). */
export type EmbedGuideCopy = (copyId: string, viewInputs: CopyButtonViewInputs) => Html

/** Where the guide's copy buttons live: the owner's `Copies` record, or the owner's own Blocks. */
export type GuideCopies<M> =
	| Readonly<{
			copies: Copies
			/** Lifts a copy fact (it carries the button's id) into the owner's Message. */
			toCopyMessage: (message: CopyMessage) => M
	  }>
	| Readonly<{ embedCopy: EmbedGuideCopy }>

export type ConnectGuideOptions<M> = Readonly<{
	/** Prefix for this instance's copy buttons and input id. */
	id: string
	endpoint: string
	note?: Html
}> &
	GuideCopies<M>

const embedOf = <M>(h: HtmlBuilder<M>, copies: GuideCopies<M>): EmbedGuideCopy =>
	"embedCopy" in copies
		? copies.embedCopy
		: (copyId, viewInputs) =>
				copiesButton(h, { ...viewInputs, copies: copies.copies, id: copyId, toMessage: copies.toCopyMessage })

/** `copyableField`'s markup with the copy button supplied by `embed`; xs input-group sizing as there. */
const INPUT_GROUP_COPY_CLASS = "px-[calc(--spacing(2)-1px)] [&_svg:not([class*='size-'])]:size-3"

const endpointField = <M>(h: HtmlBuilder<M>, id: string, value: string, embed: EmbedGuideCopy): Html =>
	h.div(
		[h.Class(copyableFieldStyles)],
		[
			h.label([h.Class(copyableFieldLabelStyles)], ["OTLP/HTTP endpoint"]),
			inputGroup(h, {}, [
				inputGroupInput(h, {
					id,
					className: copyableFieldInputStyles,
					attributes: [h.Readonly(true), h.Value(value)],
				}),
				inputGroupAddon(h, { align: "inline-end" }, [
					embed(id, { value, label: "OTLP/HTTP endpoint", className: INPUT_GROUP_COPY_CLASS }),
				]),
			]),
		],
	)

export const connectGuide = <M>(h: HtmlBuilder<M>, options: ConnectGuideOptions<M>): Html => {
	const env = otelEnvBlock(options.endpoint)
	const endpointId = `${options.id}-endpoint`
	const envId = `${options.id}-env`
	const embed = embedOf(h, options)
	return h.div(
		[h.Class("w-full space-y-3 text-left")],
		[
			endpointField(h, endpointId, options.endpoint, embed),
			h.div(
				[h.Class("space-y-1")],
				[
					h.div(
						[h.Class("flex items-center justify-between")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Exporter environment"]),
							embed(envId, {
								value: env,
								label: "Environment variables",
								idleLabel: "Copy",
								iconSize: 12,
							}),
						],
					),
					h.pre(
						[
							h.Class(
								"overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-[11px] leading-relaxed",
							),
						],
						[env],
					),
				],
			),
			h.p(
				[h.Class("text-xs text-muted-foreground")],
				[
					"No API key needed. Local Maple takes OTLP over HTTP only, so keep the protocol line: .NET and the Python distro default to gRPC.",
				],
			),
			...(options.note === undefined ? [] : [options.note]),
			h.a(
				[
					h.Href(DOCS_LOCAL_MODE_SEND_TELEMETRY),
					h.Target("_blank"),
					h.Rel("noopener noreferrer"),
					h.Class(
						"inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground",
					),
				],
				["OTLP setup docs"],
			),
		],
	)
}
