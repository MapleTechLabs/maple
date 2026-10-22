import { DEFAULT_LOCAL_PORT } from "../lib/constants"
import { DOCS_CLI_REFERENCE, DOCS_LOCAL_MODE_INSTALL, INSTALL_METHODS } from "../lib/links"
import { copyableField } from "@maple/web/ui/copyable-field"
import { separator } from "@maple/web/ui/display"
import * as TabsView from "@maple/web/ui/tabs-view"
import { copyOf } from "../page/kit/copies"
import { button } from "@maple/web/ui/button"
import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/web/ui/empty"
import { icon } from "@maple/web/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"
import type { Rejection } from "../server/state"

// The screens shown when the server is unreachable or refuses this page.

/** `startCommand`: the command that starts a server on the port this page expects. */
const startCommand = (port: string): string =>
	port === DEFAULT_LOCAL_PORT ? "maple start" : `maple start --port ${port}`

const inlineCode = (h: HtmlBuilder<Message>, text: string) =>
	h.code([h.Class("rounded bg-muted px-1")], [text])

/** A hosted page (local.maple.dev) reaches the binary across the local-network gate. */
const hostedHint = (h: HtmlBuilder<Message>): Html =>
	h.p(
		[h.Class("text-left text-xs text-muted-foreground")],
		[
			"This page runs on local.maple.dev and talks to your machine directly, so your browser may ask to allow access to devices on your local network: allow it. Running on another port? Add ",
			inlineCode(h, "?port=<n>"),
			" to the URL. To skip the prompt, run",
			" ",
			inlineCode(h, "maple start --offline"),
			" and open the URL it prints.",
		],
	)

const retry = (h: HtmlBuilder<Message>, className?: string): Html =>
	button(
		h,
		{
			variant: "outline",
			size: "sm",
			className,
			attributes: [h.OnClick(Message.ClickedRetryConnection())],
		},
		["Try again"],
	)

/** The server answered but turned this page away (403 origin rejected, 400, ...). */
export const rejectedState = (h: HtmlBuilder<Message>, rejection: Rejection): Html =>
	empty(
		h,
		[
			emptyMedia(h, { variant: "icon" }, [
				icon(h, "CircleWarningIcon", { className: "text-destructive" }),
			]),
			emptyHeader(h, [
				emptyTitle(h, ["Maple Local refused this page (", String(rejection.status), ")"]),
				emptyDescription(h, [
					rejection.status === 403
						? "The server only accepts the dashboard it was started for. Open the URL that maple start printed, or restart it without a custom UI origin."
						: "The server rejected the status request.",
				]),
			]),
			emptyContent(
				h,
				[
					...(rejection.detail
						? [
								h.pre(
									[
										h.Class(
											"whitespace-pre-wrap break-all rounded-md border bg-muted/40 px-3 py-2 text-left font-mono text-[11px]",
										),
									],
									[rejection.detail],
								),
							]
						: []),
					retry(h, "self-center"),
				],
				"w-full max-w-md items-stretch gap-3",
			),
		],
		"h-full",
	)

const field = (
	h: HtmlBuilder<Message>,
	model: Model,
	id: string,
	label: string,
	value: string,
	copyLabel?: string,
) =>
	copyableField(h, {
		id,
		label: label === "" ? undefined : label,
		copyLabel,
		value,
		copy: copyOf(model.copies, id),
		toCopyMessage: (message) => Message.GotCopyMessage({ id, message }),
	})

const docsLink = (h: HtmlBuilder<Message>, href: string, label: string) =>
	h.a(
		[
			h.Href(href),
			h.Target("_blank"),
			h.Rel("noopener noreferrer"),
			h.Class("underline underline-offset-2 hover:no-underline"),
		],
		[label],
	)

/** `InstallCommands`: Homebrew or the install script, for a machine without the CLI. */
const installCommands = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.submodel({
		slotId: "install-tabs",
		model: model.installTabs,
		view: TabsView.view,
		toParentMessage: (message) => Message.GotInstallTabsMessage({ message }),
		viewInputs: {
			variant: "underline",
			labels: INSTALL_METHODS.map((method) => method.label),
			className: "gap-2",
			listClassName: "justify-start",
			panelClassName: "mt-0",
			panel: (value) => {
				const method = INSTALL_METHODS.find((entry) => entry.id === value)
				return method === undefined
					? undefined
					: [field(h, model, `install-${method.id}`, "", method.command, "Command")]
			},
		},
	})

/** Shown in place of the views when nothing answers on the expected port. */
export const disconnectedState = (h: HtmlBuilder<Message>, model: Model): Html =>
	empty(
		h,
		[
			emptyMedia(h, { variant: "icon" }, [
				icon(h, "ConnectionIcon", { className: "text-muted-foreground" }),
			]),
			emptyHeader(h, [
				emptyTitle(h, ["Can’t reach Maple Local"]),
				emptyDescription(h, [
					"Nothing is answering on port ",
					model.env.port,
					". Start the local server and this page connects on its own.",
				]),
			]),
			emptyContent(
				h,
				[
					installCommands(h, model),
					separator(h, "horizontal", undefined),
					h.span(
						[
							h.Class(
								"text-left text-[11px] font-semibold uppercase tracking-widest text-muted-foreground",
							),
						],
						["Already installed?"],
					),
					field(h, model, "start-maple", "Start Maple", startCommand(model.env.port)),
					field(h, model, "expecting", "Expecting", model.env.otlpEndpoint),
					...(model.env.isHosted ? [hostedHint(h)] : []),
					h.div(
						[h.Class("flex items-center justify-between gap-2")],
						[
							retry(h),
							h.span(
								[h.Class("flex items-center gap-2 text-xs text-muted-foreground")],
								[
									docsLink(h, DOCS_LOCAL_MODE_INSTALL, "Local mode"),
									h.span([h.AriaHidden(true)], ["·"]),
									docsLink(h, DOCS_CLI_REFERENCE, "CLI reference"),
								],
							),
						],
					),
				],
				"w-full max-w-md items-stretch gap-3 text-left",
			),
		],
		"h-full overflow-auto",
	)
