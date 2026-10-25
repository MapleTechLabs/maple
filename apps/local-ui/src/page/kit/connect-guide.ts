import { DOCS_LOCAL_MODE_SEND_TELEMETRY } from "../../lib/links"
import { copyableField } from "@maple/web/ui/copyable-field"
import * as CopyButton from "@maple/web/ui/copy-button"
import type { Html, HtmlBuilder } from "foldkit/html"
import { type Copies, copyOf } from "./copies"

// The one "how to send telemetry here" block.

/** `otelEnvBlock`: `http/protobuf` spelled out, the server speaks OTLP over HTTP only. */
export const otelEnvBlock = (endpoint: string, serviceName = "my-service"): string =>
	[
		`OTEL_EXPORTER_OTLP_ENDPOINT=${endpoint}`,
		"OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf",
		`OTEL_SERVICE_NAME=${serviceName}`,
	].join("\n")

export type ConnectGuideOptions<M> = Readonly<{
	/** Prefix for this instance's copy buttons and input id. */
	id: string
	endpoint: string
	copies: Copies
	toCopyMessage: (id: string, message: CopyButton.Message) => M
	note?: Html
}>

export const connectGuide = <M>(h: HtmlBuilder<M>, options: ConnectGuideOptions<M>): Html => {
	const env = otelEnvBlock(options.endpoint)
	const endpointId = `${options.id}-endpoint`
	const envId = `${options.id}-env`
	return h.div(
		[h.Class("w-full space-y-3 text-left")],
		[
			copyableField(h, {
				id: endpointId,
				label: "OTLP/HTTP endpoint",
				value: options.endpoint,
				copy: copyOf(options.copies, endpointId),
				toCopyMessage: (message) => options.toCopyMessage(endpointId, message),
			}),
			h.div(
				[h.Class("space-y-1")],
				[
					h.div(
						[h.Class("flex items-center justify-between")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Exporter environment"]),
							CopyButton.view(h, {
								model: copyOf(options.copies, envId),
								toParentMessage: (message) => options.toCopyMessage(envId, message),
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
