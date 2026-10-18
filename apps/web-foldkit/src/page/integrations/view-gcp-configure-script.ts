import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import * as CopyButton from "../../ui/copy-button"
import { icon } from "../../ui/icon"
import { skeleton } from "../../ui/skeleton"
import type { ConfigureModel } from "./gcp-configure-schema"
import { Message } from "./message"
import type { Model } from "./model"
import { openCloudShellButton, type ScriptFailure } from "./view-gcp-parts"

// `ScriptCard`: the setup script, copied or run straight from Cloud Shell; the start shows.

type H = HtmlBuilder<Message>

const COPY_ID = "configure-setup-script"

export const scriptCard = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	options: Readonly<{ script: string | null; failure: ScriptFailure | null; projectId: string }>,
): Html => {
	const { script, failure } = options
	const expanded = configure.isScriptExpanded
	const text = script?.trimEnd() ?? null
	return h.div(
		[h.Class("overflow-clip rounded-lg border")],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2 border-b bg-muted/40 px-3 py-2")],
				[
					h.span(
						[h.Class("font-mono text-xs text-muted-foreground")],
						[
							"setup.sh",
							...(text === null ? [] : [` · ${countLabel(text.split("\n").length, "line")}`]),
						],
					),
					h.span(
						[h.Class("ml-auto flex items-center gap-2")],
						[
							CopyButton.view(h, {
								model: model.gcpCard.copies[COPY_ID] ?? CopyButton.init(),
								toParentMessage: (message) =>
									Message.GotGcpCopyMessage({ id: COPY_ID, message }),
								value: script ?? "",
								label: "script",
								idleLabel: "Copy script",
								variant: "outline",
								size: "sm",
								attributes: script === null ? [h.Disabled(true)] : [],
							}),
							openCloudShellButton(h, options.projectId, "default"),
						],
					),
				],
			),
			failure !== null
				? h.div(
						[h.Class("flex flex-wrap items-center gap-2 p-3")],
						[
							h.p([h.Class("text-xs text-severity-error"), h.Role("alert")], [failure.message]),
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									isLoading: failure.isRetrying,
									attributes: [h.OnClick(Message.ClickedGcpConfigureScriptRetry())],
								},
								["Try again"],
							),
						],
					)
				: text === null
					? h.div([h.Class("p-3")], [skeleton(h, "h-26 w-full")])
					: scriptText(h, text, expanded),
			footer(h, text !== null && failure === null, expanded),
		],
	)
}

/** The dashboard records itself with rrweb, which serializes plain text verbatim (`rr-block`). */
const scriptText = (h: H, text: string, expanded: boolean): Html =>
	h.div(
		[h.Class("relative")],
		[
			h.pre(
				[
					h.Tabindex(0),
					h.Role("region"),
					h.AriaLabel("The setup script"),
					h.Class(
						cn(
							"p-3 font-mono text-xs/5 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/40",
							expanded
								? "max-h-80 overflow-auto"
								: "max-h-32 overflow-x-auto overflow-y-hidden",
							"rr-block",
						),
					),
				],
				[text],
			),
			...(expanded
				? []
				: [
						h.div([
							h.AriaHidden(true),
							h.Class(
								"pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-popover to-transparent",
							),
						]),
					]),
		],
	)

const footer = (h: H, canExpand: boolean, expanded: boolean): Html =>
	h.div(
		[h.Class("flex items-center gap-1.5 border-t px-3 py-1.5 text-xs/5 text-muted-foreground")],
		[
			icon(h, "LockIcon", { size: 12, className: "shrink-0" }),
			h.span(
				[h.Class("min-w-0 flex-1 text-pretty")],
				["Holds this connection's secret. Don't share or commit it."],
			),
			...(canExpand
				? [
						button(
							h,
							{
								variant: "link",
								size: "xs",
								className:
									"h-auto p-0 font-normal text-xs text-muted-foreground hover:text-foreground",
								attributes: [
									h.AriaExpanded(expanded),
									h.OnClick(Message.ClickedGcpScriptExpand()),
								],
							},
							[expanded ? "Show less" : "Show all"],
						),
					]
				: []),
		],
	)
