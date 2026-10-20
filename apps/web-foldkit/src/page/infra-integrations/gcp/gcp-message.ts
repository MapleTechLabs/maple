import { gcpMessageParts } from "../../../components/integrations/gcp-connector-state"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, hrefOf } from "../../../route"
import { icon } from "../../../ui/icon"

// `GcpMessage`, `Linked` and `GcpExternalLink`: a failure in the API's own words, laid out to be scanned.

const GCP_LINK = "underline underline-offset-2 hover:no-underline"
const BILLING_PAGE = "Settings, Billing"
const LINK_PATTERN = new RegExp(`(https://[^\\s)]*[^\\s).,]|${BILLING_PAGE})`)

const externalLink = <M>(h: HtmlBuilder<M>, href: string, text: string): Html =>
	h.a(
		[
			h.Class(cn(GCP_LINK, text !== href && "whitespace-nowrap")),
			h.Href(href),
			h.Rel("noreferrer"),
			h.Target("_blank"),
		],
		[
			text,
			h.span(
				[h.Class("whitespace-nowrap")],
				["⁠", icon(h, "ExternalLinkIcon", { size: 12, className: "ml-1 inline align-[-1px]" })],
			),
		],
	)

const linked = <M>(h: HtmlBuilder<M>, text: string): ReadonlyArray<Html | string> =>
	text
		.split(LINK_PATTERN)
		.map((part, index) =>
			index % 2 === 0
				? part
				: part === BILLING_PAGE
					? h.a(
							[
								h.Class(GCP_LINK),
								h.Href(hrefOf(AppRoute.Settings({ search: { tab: "billing" } }))),
							],
							[part],
						)
					: externalLink(
							h,
							part,
							part.startsWith("https://console.cloud.google.com/")
								? "Google Cloud console"
								: part,
						),
		)

export const gcpMessage = <M>(h: HtmlBuilder<M>, text: string): Html => {
	const { headline, body, answer } = gcpMessageParts(text)
	return h.div(
		[h.Class("flex flex-col gap-1 [overflow-wrap:anywhere]")],
		[
			h.p([h.Class("font-medium text-pretty text-foreground")], linked(h, headline)),
			...(body.length === 0
				? []
				: body.length === 1
					? [h.p([h.Class("text-pretty text-muted-foreground")], linked(h, body[0] ?? ""))]
					: [
							h.ul(
								[h.Class("list-disc pl-4 text-pretty text-muted-foreground")],
								body.map((sentence) => h.li([], linked(h, sentence))),
							),
						]),
			...(answer === null ? [] : [h.p([h.Class("text-2xs text-muted-foreground/80")], [answer])]),
		],
	)
}
