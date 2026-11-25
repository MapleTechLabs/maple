import type { AiCardGate } from "@maple/domain/billing"
import { alert, alertAction, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { linkButton } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"

// Where Maple AI starts, while it waits on billing (`PageContext.aiCardGate`): the notice a surface
// shows in place of its AI, and the link that takes a start button's place. The server refuses the
// same orgs (`aiCardGateOf`), so these only say so before anyone clicks.

const BILLING_HREF = hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))

const COPY = {
	trial: {
		title: "Add a card to turn on Maple AI",
		body: "Investigations, chat, code review and security audits start once a card is on file. Nothing is charged until your free trial ends.",
		action: "Add card",
		short: "Add card to use AI",
	},
	no_plan: {
		title: "Maple AI needs an active plan",
		body: "Subscribe to run investigations, chat, code review and security audits again.",
		action: "Subscribe",
		short: "Subscribe to use AI",
	},
} as const satisfies Record<AiCardGate, Readonly<Record<"title" | "body" | "action" | "short", string>>>

/** The callout an AI surface shows while Maple AI waits on a card (or a plan), linking to Billing. */
export const aiCardNotice = <M>(
	h: HtmlBuilder<M>,
	gate: AiCardGate,
	options: Readonly<{ className?: string; size?: "sm" }> = {},
): Html =>
	alert(
		h,
		{
			variant: "info",
			role: "status",
			...(options.size === undefined ? undefined : { size: options.size }),
			...(options.className === undefined ? undefined : { className: options.className }),
		},
		[
			icon(h, "CreditCardIcon"),
			alertTitle(h, [COPY[gate].title], "text-foreground"),
			alertDescription(h, [COPY[gate].body]),
			alertAction(h, [linkButton(h, { size: "sm", href: BILLING_HREF }, [COPY[gate].action])]),
		],
	)

/** The link in an AI start button's place ("Add card to use AI"), its tooltip saying why. */
export const aiCardAction = <M>(
	h: HtmlBuilder<M>,
	gate: AiCardGate,
	options: Readonly<{ size?: "sm" | "xs" }> = {},
): Html =>
	linkButton(
		h,
		{
			size: options.size ?? "sm",
			variant: "outline",
			href: BILLING_HREF,
			attributes: [h.Title(COPY[gate].body)],
		},
		[icon(h, "CreditCardIcon"), COPY[gate].short],
	)
