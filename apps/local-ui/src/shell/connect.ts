import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import * as Popover from "@maple/views/ui/popover"
import { inlineCode } from "@maple/views/ui/inline-code"
import { typography } from "@maple/views/ui/typography"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"
import { connectGuide } from "../page/kit/connect-guide"

// The connect button: a popover with the local ingest endpoint and
// exporter env. Loud until the first telemetry lands, a quiet outline after.

export const CONNECT_POPOVER_ID = "connect"

const note = (h: HtmlBuilder<Message>): Html =>
	typography(
		h,
		{ as: "p", size: "xs", tone: "muted" },
		[
			"Recording browser sessions? Point",
			" ",
			inlineCode(h, {}, ["@maple-dev/browser"]),
			" at the same endpoint.",
		],
	)

export const connectButton = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "connect-popover",
		model: model.connect,
		view: Popover.view,
		toParentMessage: (message) => Message.GotConnectMessage({ message }),
		viewInputs: {
			className: "w-[min(26rem,calc(100vw-2rem))]",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								variant: model.hasIngested ? "outline" : "default",
								size: "sm",
								className:
									"flex-1 justify-start gap-2 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:flex-none group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:p-0",
								slot: "popover-trigger",
								attributes: [h.AriaLabel("Connect your app"), ...trigger],
							},
							[icon(h, "ConnectionIcon"), h.span([h.Class("group-data-[collapsible=icon]:hidden")], ["Connect"])],
						),
					),
				),
			toContent: () => [
				h.div(
					[h.Class("space-y-4")],
					[
						h.div(
							[h.Class("space-y-1")],
							[
								Popover.popoverTitle(h, CONNECT_POPOVER_ID, "Connect your app", "text-base"),
								Popover.popoverDescription(
									h,
									CONNECT_POPOVER_ID,
									"Point your OpenTelemetry SDK at your local Maple to stream traces, logs and metrics.",
									"text-xs",
								),
							],
						),
						connectGuide(h, {
							id: "connect",
							endpoint: model.env.otlpEndpoint,
							copies: model.copies,
							toCopyMessage: (id, message) => Message.GotCopyMessage({ id, message }),
							note: note(h),
						}),
					],
				),
			],
		},
	})
