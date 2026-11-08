import { countLabel } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { ingestUrl } from "../lib/services/common/ingest-url"
import { mcpUrl } from "../lib/services/common/mcp-url"
import {
	claudeCodeCommand,
	cursorInstallUrl,
	vscodeInstallUrl,
} from "../components/settings/mcp-client-config"
import { ONBOARD_SKILL_COMMAND } from "../components/ingest/onboard-skill"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../route"
import { button, linkButton } from "@maple/views/ui/button"
import * as CopyButton from "@maple/views/ui/copy-button"
import { copyableField } from "@maple/views/ui/copyable-field"
import { badge, separator } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import type { IconName } from "@maple/views/ui/icons.generated"
import { inlineCode } from "@maple/views/ui/inline-code"
import { panel } from "@maple/views/ui/panel"
import * as PopoverView from "@maple/views/ui/popover"
import { skeleton } from "@maple/views/ui/skeleton"
import { statusDot } from "@maple/views/ui/status-dot"
import { toneBoxClass } from "@maple/views/ui/tone-box"
import { type CopyField, Message, type Model, POPOVER_ID, realServices } from "./connect-panel"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { Array as Arr, Option, String as Str } from "effect"
import { textLink } from "@maple/views/ui/text-link"
import { dividedList } from "@maple/views/ui/rule"

type H = HtmlBuilder<Message>

const MCP_ENDPOINT = `${mcpUrl}/mcp`
const MCP_COMMAND = claudeCodeCommand(MCP_ENDPOINT)

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
				toneBoxClass(isConnected ? "info" : "primary"),
			),
		},
		isConnected
			? [statusDot(h, { tone: "ok" }), `Connected · ${countLabel(services.length, "service")}`]
			: [icon(h, "ClockIcon", { size: 12, className: "size-3" }), "Waiting for telemetry"],
	)
}

/** `CopyableFieldSkeleton`: a labelled field whose value is still loading. */
const fieldSkeleton = (h: H, label: string): Html =>
	h.div(
		[h.Class("space-y-1")],
		[typography(h, { size: "xs", tone: "muted" }, [label]), skeleton(h, "h-8 w-full")],
	)

/** `IngestKeysUnavailableNote`: members cannot read the org's ingest keys. */
const keysUnavailable = (h: H): Html =>
	h.p(
		[
			h.Class(
				"rounded-md border border-dashed bg-surface-sunken px-3 py-2 font-prose text-xs text-muted-foreground",
			),
		],
		[
			"Ask an org admin for your ingest keys, or open ",
			textLink(
				h,
				{
					href: hrefOf(AppRoute.Settings({ search: { tab: "ingestion" } })),
					tone: "inherit",
					className: "font-medium text-foreground underline hover:no-underline active:no-underline",
					attributes: [h.AriaLabel("Ingestion settings")],
				},
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

type ClientMark = Readonly<{ name: IconName; className: string }>

/** A client's brand mark on a tile, as the setup pages show agents. */
const clientMark = (h: H, mark: ClientMark): Html =>
	hstack(
		h,
		{
			align: "center",
			justify: "center",
			as: "span",
			className: "size-6 shrink-0 rounded-md border bg-background",
		},
		[icon(h, mark.name, { size: 14, className: mark.className })],
	)

/** `McpClientRow`: a client's mark and name, then its one way in. */
const clientRow = (h: H, mark: ClientMark, label: string, action: Html): Html =>
	hstack(h, { gap: "2.5", align: "center", as: "li", className: "min-h-10 px-3 py-1.5" }, [
		clientMark(h, mark),
		h.span([h.Class("shrink-0 font-prose text-xs font-medium text-foreground")], [label]),
		hstack(h, { gap: "1", align: "center", justify: "end", shrink: true, grow: true }, [action]),
	])

/** A copyable value at the end of a client row. */
const copyAction = (h: H, model: Model, value: string, field: CopyField, label: string): Html =>
	hstack(h, { gap: "1", align: "center", shrink: true }, [
		h.code(
			[
				h.Class(
					"min-w-0 overflow-x-auto whitespace-nowrap font-mono text-2xs text-muted-foreground scroll-fade-x [scrollbar-width:none]",
				),
			],
			[value],
		),
		CopyButton.view(h, {
			model: model.copies[field],
			toParentMessage: toCopy(field),
			value,
			label,
			className: COPY_CLASS,
		}),
	])

/** A one-click install that hands the server entry to the editor. */
const installAction = (h: H, href: string, label: string): Html =>
	linkButton(h, { size: "xs", variant: "outline", className: "gap-1", href }, [
		label,
		icon(h, "ExternalLinkIcon", { size: 12, className: "text-muted-foreground" }),
	])

/** `McpCard`: each client's fastest way to add Maple, the endpoint for any other. */
const mcpCard = (h: H, model: Model): Html =>
	h.div(
		[h.Class("space-y-2")],
		[
			hstack(h, { gap: "2", align: "baseline", justify: "between" }, [
				eyebrow(h, { variant: "label" }, ["Connect your own agent · MCP"]),
				textLink(h, { href: settingsHref("mcp"), tone: "muted", className: "shrink-0 text-xs" }, [
					"All clients",
					icon(h, "ArrowRightIcon", { size: 12 }),
				]),
			]),
			panel(h, { tone: "muted" }, [
				dividedList(h, { as: "ul", bordered: false }, [
					clientRow(
						h,
						{ name: "ClaudeIcon", className: "text-brand-claude" },
						"Claude Code",
						copyAction(h, model, MCP_COMMAND, "mcpCommand", "Claude Code command"),
					),
					clientRow(
						h,
						{ name: "CursorIcon", className: "text-foreground" },
						"Cursor",
						installAction(h, cursorInstallUrl(MCP_ENDPOINT), "Add to Cursor"),
					),
					clientRow(
						h,
						{ name: "VsCodeIcon", className: "text-brand-vscode" },
						"VS Code",
						installAction(h, vscodeInstallUrl(MCP_ENDPOINT), "Add to VS Code"),
					),
					clientRow(
						h,
						{ name: "ConnectionIcon", className: "text-primary" },
						"Any client",
						copyAction(h, model, MCP_ENDPOINT, "mcp", "MCP endpoint"),
					),
				]),
			]),
			typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
				"Your client opens Maple in the browser to approve access.",
			]),
		],
	)

/** The command split before its first flag: each half stays on one line, so a wrap breaks only there. */
const commandParts = (command: string): ReadonlyArray<string> => {
	return Option.match(Str.indexOf(" --")(command), {
		onNone: () => [command],
		onSome: (flag) => [Str.slice(0, flag)(command), Str.slice(flag + 1)(command)],
	})
}

/** The onboarding command, wrapping before `--skill` so no part hides under the copy button. */
const commandBlock = (h: H, model: Model): Html =>
	hstack(
		h,
		{
			gap: "2",
			align: "start",
			className: "rounded-lg border border-input bg-background py-1.5 pl-3 pr-1.5 dark:bg-input/32",
		},
		[
			h.div(
				[h.Class("min-w-0 flex-1 py-0.5")],
				[
					h.code(
						[
							h.Id("connect-skill-command"),
							h.Class("select-all font-mono text-xs leading-5 break-words"),
						],
						Arr.flatMap(commandParts(ONBOARD_SKILL_COMMAND), (part, index) => [
							...(index > 0 ? [" "] : []),
							h.span([h.Class("inline-block whitespace-nowrap")], [part]),
						]),
					),
				],
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
const LINK_CLASS =
	"font-prose text-muted-foreground underline underline-offset-2 hover:text-foreground active:text-foreground"

/** `ConnectPanel`. */
const connectPanel = (h: H, model: Model): ReadonlyArray<Html> => [
	h.div(
		[h.Class("space-y-4")],
		[
			h.div(
				[h.Class("space-y-1.5")],
				[
					hstack(h, { gap: "2", align: "start", justify: "between" }, [
						PopoverView.popoverTitle(h, POPOVER_ID, "Connect your app", "text-base"),
						statusPill(h, model),
					]),
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
					typography(h, { size: "xs", tone: "muted", as: "p", className: "font-prose" }, [
						"The ",
						inlineCode(h, {}, ["maple-onboard"]),
						" skill installs OpenTelemetry and wires traces, logs, and metrics end-to-end.",
					]),
				],
			),
			mcpCard(h, model),
			hstack(h, { align: "center", justify: "between", className: "text-xs" }, [
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
			]),
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
