import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../ui/alert"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import { middleTruncate } from "../../ui/middle-truncate"
import { authDescription, authLayout, authTitle } from "./auth-layout"
import { type AuthorizationInfo, Message, type Model } from "./mcp-authorize"

type H = HtmlBuilder<Message>

const status = (h: H, text: string): Html =>
	h.p([h.Role("status"), h.Class("py-8 text-center text-sm text-muted-foreground")], [text])

const failure = (h: H, message: string): Html =>
	h.div(
		[h.Class("space-y-3")],
		[
			alert(h, { variant: "crit" }, [
				icon(h, "CircleWarningIcon", { size: 16 }),
				alertDescription(h, [message], "text-destructive"),
			]),
			h.p(
				[h.Class("text-sm text-muted-foreground")],
				["Return to your MCP client and start the connection again."],
			),
		],
	)

const muted = (h: H, className: string, children: ReadonlyArray<Html | string>): Html =>
	h.p([h.Class(`${className} text-muted-foreground`)], children)

const ready = (h: H, info: AuthorizationInfo, workspace: Html): Html =>
	h.div(
		[h.Class("space-y-4")],
		[
			h.div(
				[h.Class("space-y-1 border border-border bg-muted/30 p-3")],
				[
					muted(h, "text-xs", ["Requesting client"]),
					h.p(
						[
							h.Class("line-clamp-2 font-medium [overflow-wrap:anywhere]"),
							h.Title(info.clientName),
						],
						[info.clientName],
					),
					muted(h, "text-3xs", ["Name provided by the app"]),
					h.div(
						[h.Class("flex min-w-0 gap-1 text-xs text-muted-foreground")],
						[
							h.span([h.Class("shrink-0")], ["Returns to"]),
							middleTruncate(h, { text: info.returnsTo, tail: 16 }),
						],
					),
					muted(h, "text-xs", ["Expires at ", info.expiresAtLabel]),
				],
			),
			workspace,
			h.div(
				[h.Class("space-y-1 text-sm text-muted-foreground")],
				[
					h.p([], ["This grants the client permission to:"]),
					h.ul(
						[h.Class("list-disc space-y-1 pl-5")],
						[
							h.li([], ["Search and inspect telemetry through Maple MCP tools"]),
							h.li([], ["Act with your current role in this workspace"]),
						],
					),
				],
			),
			h.div(
				[h.Class("flex gap-2")],
				[
					button(
						h,
						{
							variant: "outline",
							className: "flex-1",
							attributes: [h.OnClick(Message.ClickedDecision({ action: "deny" }))],
						},
						["Deny"],
					),
					button(
						h,
						{
							className: "flex-1",
							attributes: [h.OnClick(Message.ClickedDecision({ action: "approve" }))],
						},
						["Approve"],
					),
				],
			),
		],
	)

const stateView = (h: H, model: Model, workspace: Html): Html => {
	switch (model.state._tag) {
		case "Loading":
			return status(h, "Checking authorization…")
		case "Redirecting":
			return status(h, "Returning to your MCP client…")
		case "Failed":
			return failure(h, model.state.message)
		case "Ready":
			return ready(h, model.state.info, workspace)
	}
}

export const view = (h: H, model: Model, workspace: Html): Html =>
	authLayout(h, "max-w-md", [
		h.div(
			[h.Class("space-y-5")],
			[
				h.div(
					[],
					[
						authTitle(h, ["Authorize Maple MCP"]),
						authDescription(h, ["Connect an AI client to your Maple observability workspace."]),
					],
				),
				stateView(h, model, workspace),
			],
		),
	])
