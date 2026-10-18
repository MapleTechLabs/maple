import { button } from "@maple/web-foldkit/ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/web-foldkit/ui/empty"
import { icon } from "@maple/web-foldkit/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Message } from "../message"
import type { Model } from "../model"
import type { Rejection } from "../server/state"

// `DisconnectedState` and `RejectedState` (apps/local-ui/src/components/view-states.tsx).

const retry = (h: HtmlBuilder<Message>, className?: string): Html =>
	button(h, { variant: "outline", size: "sm", className, attributes: [h.OnClick(Message.ClickedRetryConnection())] }, [
		"Try again",
	])

/** The server answered but turned this page away (403 origin rejected, 400, ...). */
export const rejectedState = (h: HtmlBuilder<Message>, rejection: Rejection): Html =>
	empty(
		h,
		[
			emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { className: "text-destructive" })]),
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

/**
 * Shown in place of the views when nothing answers on the expected port.
 * TODO(disconnected): the install-command tabs, copyable fields and docs links are not ported;
 * no parity scenario reaches this state (the harness cannot refuse a connection yet).
 */
export const disconnectedState = (h: HtmlBuilder<Message>, model: Model): Html =>
	empty(
		h,
		[
			emptyMedia(h, { variant: "icon" }, [icon(h, "ConnectionIcon", { className: "text-muted-foreground" })]),
			emptyHeader(h, [
				emptyTitle(h, ["Can’t reach Maple Local"]),
				emptyDescription(h, [
					`Nothing is answering on port ${model.env.port}. Start the local server and this page connects on its own.`,
				]),
			]),
			emptyContent(h, [retry(h)], "w-full max-w-md items-stretch gap-3 text-left"),
		],
		"h-full overflow-auto",
	)
