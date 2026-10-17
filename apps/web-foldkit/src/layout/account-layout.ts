import type { Html, HtmlBuilder } from "foldkit/html"
import { mapleMark } from "../ui/icons"

const WEBSITE_URL = "https://maple.dev"
const DOCS_URL = "https://maple.dev/docs"

/** `<AccountLayout>` (apps/web/src/components/layout/account-layout.tsx): artwork left, form right. */
export const accountLayout = <Message>(h: HtmlBuilder<Message>, children: ReadonlyArray<Html>): Html =>
	h.main(
		[h.Class("account-layout dark")],
		[
			h.aside(
				[h.Class("account-art")],
				[
					h.img([
						h.Src("/art/maple-auth-arch.webp"),
						h.Alt(""),
						h.Class("account-art-image"),
						h.Fetchpriority("high"),
					]),
					h.a(
						[h.Class("account-wordmark"), h.Href(WEBSITE_URL), h.AriaLabel("Maple home")],
						[mapleMark(h, 30), h.span([], ["Maple"])],
					),
					h.div(
						[h.Class("account-art-copy")],
						[
							h.p([h.Class("account-eyebrow")], ["Open-source observability"]),
							h.p([h.Class("account-art-headline")], ["Understand", h.br([]), "what’s happening."]),
							h.p([], ["Traces, logs, and metrics.", h.br([]), "One place to see the whole picture."]),
						],
					),
				],
			),
			h.section(
				[h.Class("account-content"), h.AriaLabel("Your Maple account")],
				[
					h.header(
						[h.Class("account-header")],
						[
							h.a(
								[h.Class("account-mobile-wordmark"), h.Href(WEBSITE_URL), h.AriaLabel("Maple home")],
								[mapleMark(h, 26), h.span([], ["Maple"])],
							),
							h.a([h.Class("account-back"), h.Href(WEBSITE_URL)], ["Back to website"]),
						],
					),
					h.div([h.Class("account-form")], children),
					h.footer(
						[h.Class("account-footer")],
						[h.span([], ["Built on OpenTelemetry."]), h.a([h.Href(DOCS_URL)], ["Documentation"])],
					),
				],
			),
		],
	)
