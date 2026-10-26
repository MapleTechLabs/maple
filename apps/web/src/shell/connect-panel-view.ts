import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { ingestUrl } from "../lib/services/common/ingest-url"
import { mcpUrl } from "../lib/services/common/mcp-url"
import { ONBOARD_SKILL_COMMAND } from "../components/ingest/onboard-skill"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../route"
import { button } from "../ui/button"
import * as CopyButton from "../ui/copy-button"
import { copyableField } from "../ui/copyable-field"
import { badge, separator } from "../ui/display"
import { eyebrow } from "../ui/eyebrow"
import { icon } from "../ui/icon"
import { inlineCode } from "../ui/inline-code"
import { panel } from "../ui/panel"
import * as PopoverView from "../ui/popover"
import { skeleton } from "../ui/skeleton"
import { statusDot } from "../ui/status-dot"
import { type CopyField, Message, type Model, POPOVER_ID, realServices } from "./connect-panel"

type H = HtmlBuilder<Message>

const MCP_ENDPOINT = `${mcpUrl}/mcp`

/** The endpoint field's input-group glyph size, so every copy button in the panel matches it. */
const COPY_CLASS = "shrink-0 [&_svg:not([class*='size-'])]:size-4"

const toCopy = (field: CopyField) => (message: CopyButton.Message) =>
	Message.GotCopyMessage({ field, message })

/** `ConnectionStatusPill`: amber while waiting, green once telemetry is observed, grey when the read failed. */
const statusPill = (h: H, model: Model): Html => {
	const services = realServices(model)
	const isConnected = services.length > 0
	if (!isConnected && model.isOverviewFailed) {
		return badge(h, { pill: true, variant: "meta", className: "gap-1.5 text-2xs sm:text-2xs" }, [
			statusDot(h, { tone: "neutral" }),
			"Status unknown",
		])
	}
	return badge(
		h,
		{
			pill: true,
			className: cn(
				"gap-1.5 text-2xs transition-colors sm:text-2xs",
				isConnected
					? "border-severity-info/30 bg-severity-info/10 text-severity-info"
					: "border-primary/30 bg-primary/10 text-primary",
			),
		},
		isConnected
			? [statusDot(h, { tone: "ok" }), `Connected · ${countLabel(services.length, "service")}`]
			: [icon(h, "ClockIcon", { size: 11, className: "size-[11px]" }), "Waiting for telemetry"],
	)
}

/** `CopyableFieldSkeleton`: a labelled field whose value is still loading. */
const fieldSkeleton = (h: H, label: string): Html =>
	h.div(
		[h.Class("space-y-1")],
		[h.span([h.Class("text-xs text-muted-foreground")], [label]), skeleton(h, "h-8 w-full")],
	)

/** `IngestKeysUnavailableNote`: members cannot read the org's ingest keys. */
const keysUnavailable = (h: H): Html =>
	h.p(
		[
			h.Class(
				"rounded-md border border-dashed bg-muted/40 px-3 py-2 font-prose text-xs text-muted-foreground",
			),
		],
		[
			"Ask an org admin for your ingest keys, or open ",
			h.a(
				[
					h.Href(hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } }))),
					h.AriaLabel("Ingestion settings"),
					h.Class(
						"inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2 hover:no-underline",
					),
				],
				[
					"Settings",
					icon(h, "ArrowRightIcon", { size: 12, attributes: [h.AriaHidden(true)] }),
					"Ingestion",
				],
			),
			".",
		],
	)

/** `ConnectCredentials`: the endpoint and both keys, masked. */
const credentials = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			copyableField(h, {
				id: "connect-ingest-endpoint",
				label: "Ingest endpoint",
				value: ingestUrl,
				copy: model.copies.endpoint,
				toCopyMessage: toCopy("endpoint"),
			}),
			...(model.keys._tag === "Failed"
				? [keysUnavailable(h)]
				: model.keys._tag === "Ready"
					? [
							copyableField(h, {
								id: "connect-public-key",
								label: "Public key",
								value: model.keys.publicKey,
								copy: model.copies.publicKey,
								toCopyMessage: toCopy("publicKey"),
								masked: {
									isVisible: model.isPublicKeyVisible,
									onToggle: Message.ClickedRevealPublicKey(),
								},
							}),
							copyableField(h, {
								id: "connect-private-key",
								label: "Private key",
								value: model.keys.privateKey,
								copy: model.copies.privateKey,
								toCopyMessage: toCopy("privateKey"),
								masked: {
									isVisible: model.isPrivateKeyVisible,
									onToggle: Message.ClickedRevealPrivateKey(),
								},
							}),
						]
					: [fieldSkeleton(h, "Public key"), fieldSkeleton(h, "Private key")]),
		],
	)

const settingsHref = (tab: "ingestion" | "mcp") => hrefOf(AppRoute.Settings({ search: { tab } }))

/** `McpCard`: the MCP settings link and the copyable endpoint. */
const mcpCard = (h: H, model: Model): Html =>
	panel(h, { tone: "muted", className: "group transition-colors hover:border-foreground/20" }, [
		h.a(
			[
				h.Href(settingsHref("mcp")),
				h.Class(
					"flex items-center gap-3 p-3 outline-none focus-visible:ring-2 focus-visible:ring-ring",
				),
			],
			[
				h.span(
					[
						h.Class(
							"flex size-8 shrink-0 items-center justify-center rounded-md border bg-background text-foreground",
						),
					],
					[icon(h, "ChatBubbleSparkleIcon", { size: 15 })],
				),
				h.span(
					[h.Class("min-w-0 flex-1 space-y-0.5")],
					[
						h.span(
							[h.Class("flex items-center font-prose text-xs font-medium text-foreground")],
							["Connect your own agent"],
						),
						h.span(
							[h.Class("block font-prose text-xs text-muted-foreground")],
							["Claude Code, Cursor, or any MCP client can query your telemetry."],
						),
					],
				),
				icon(h, "ArrowRightIcon", {
					size: 14,
					className:
						"shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:text-foreground",
				}),
			],
		),
		h.div(
			[h.Class("flex items-center gap-2 border-t bg-background/60 py-1.5 pl-3 pr-1.5")],
			[
				eyebrow(h, {}, ["MCP"]),
				h.code(
					[
						h.Class(
							"min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs text-muted-foreground scroll-fade-x [scrollbar-width:none]",
						),
					],
					[MCP_ENDPOINT],
				),
				CopyButton.view(h, {
					model: model.copies.mcp,
					toParentMessage: toCopy("mcp"),
					value: MCP_ENDPOINT,
					label: "MCP endpoint",
					className: COPY_CLASS,
				}),
			],
		),
	])

/** The command split before its first flag: each half stays on one line, so a wrap breaks only there. */
const commandParts = (command: string): ReadonlyArray<string> => {
	const flag = command.indexOf(" --")
	return flag === -1 ? [command] : [command.slice(0, flag), command.slice(flag + 1)]
}

/** The onboarding command, wrapping before `--skill` so no part hides under the copy button. */
const commandBlock = (h: H, model: Model): Html =>
	h.div(
		[
			h.Class(
				"flex items-start gap-2 rounded-lg border border-input bg-background py-1.5 pl-3 pr-1.5 dark:bg-input/32",
			),
		],
		[
			h.code(
				[
					h.Id("connect-skill-command"),
					h.Class("min-w-0 flex-1 select-all py-0.5 font-mono text-xs leading-5 break-words"),
				],
				commandParts(ONBOARD_SKILL_COMMAND).flatMap((part, index) => [
					...(index > 0 ? [" "] : []),
					h.span([h.Class("inline-block whitespace-nowrap")], [part]),
				]),
			),
			CopyButton.view(h, {
				model: model.copies.skill,
				toParentMessage: toCopy("skill"),
				value: ONBOARD_SKILL_COMMAND,
				label: "Command",
				className: COPY_CLASS,
			}),
		],
	)

/** The footer's two links share one style. */
const LINK_CLASS = "font-prose text-muted-foreground underline underline-offset-2 hover:text-foreground"

/** `ConnectPanel`. */
const connectPanel = (h: H, model: Model): ReadonlyArray<Html> => [
	h.div(
		[h.Class("space-y-4")],
		[
			h.div(
				[h.Class("space-y-1.5")],
				[
					h.div(
						[h.Class("flex items-start justify-between gap-2")],
						[
							PopoverView.popoverTitle(h, POPOVER_ID, "Connect your app", "text-base"),
							statusPill(h, model),
						],
					),
					PopoverView.popoverDescription(
						h,
						POPOVER_ID,
						"Point your OpenTelemetry SDK at this endpoint to start streaming telemetry into Maple.",
						"text-xs",
					),
				],
			),
			credentials(h, model),
			separator(h, "horizontal", undefined),
			h.div(
				[h.Class("space-y-2")],
				[
					eyebrow(h, { variant: "label" }, ["Fastest path · Claude Code"]),
					commandBlock(h, model),
					h.p(
						[h.Class("font-prose text-xs text-muted-foreground")],
						[
							"The ",
							inlineCode(h, {}, ["maple-onboard"]),
							" skill installs OpenTelemetry and wires traces, logs, and metrics end-to-end.",
						],
					),
				],
			),
			mcpCard(h, model),
			h.div(
				[h.Class("flex items-center justify-between text-xs")],
				[
					h.a([h.Href(settingsHref("ingestion")), h.Class(LINK_CLASS)], ["Open setup guide"]),
					h.a(
						[
							h.Href("https://maple.dev/docs"),
							h.Target("_blank"),
							h.Rel("noopener noreferrer"),
							h.Class(LINK_CLASS),
						],
						["Documentation"],
					),
				],
			),
		],
	),
]

/** `ConnectButton`: the popover trigger and, while open, the panel. */
export const view = Submodel.defineView<Model, Message>((model, h) =>
	h.submodel({
		slotId: "shell-connect-popover",
		model: model.popover,
		view: PopoverView.view,
		viewInputs: {
			// Wide enough to cover the page header actions under it, not leave a sliver of one showing.
			className: "w-[27.5rem] max-w-[calc(100vw-1rem)]",
			toContent: () => (model.popover.isOpen ? connectPanel(h, model) : []),
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							// Outline: each page's own primary action keeps the orange; empty states carry the on-ramp.
							{
								size: "sm",
								variant: "outline",
								className: "gap-2",
								slot: "popover-trigger",
								attributes: trigger,
							},
							[icon(h, "ConnectionIcon", { className: "text-primary" }), "Connect"],
						),
					),
				),
		},
		toParentMessage: (message) => Message.GotPopoverMessage({ message }),
	}),
)
