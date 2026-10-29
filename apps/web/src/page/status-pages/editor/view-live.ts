import type { V2StatusPage } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { apiPublicUrl } from "../../../lib/services/common/api-base-url"
import { button, linkButton } from "../../../ui/button"
import { copyableField } from "../../../ui/copyable-field"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { publicUrl, statusPageHref } from "../shared/commands"
import { Message } from "./message"
import type { Model } from "./model"
import { revealedToken } from "./view-settings"

// Right after Publish: the page is live, where it lives, and the two things worth doing next.

type H = HtmlBuilder<Message>

/** In place of a link that would not resolve: prd has no status domain yet. */
export const NO_DOMAIN_NOTE = "Public address appears once a status domain is configured"

/** The header's address: a link to the public page, or the note while there is no status domain. */
export const addressLine = (h: H, model: Model, page: V2StatusPage): Html => {
	const url = publicUrl(model.publicBaseUrl, page.slug)
	return url === null
		? h.span([h.Class("text-xs text-muted-foreground")], [NO_DOMAIN_NOTE])
		: h.a(
				[
					h.Href(url),
					h.Target("_blank"),
					h.Rel("noopener"),
					h.Class(
						"font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline",
					),
				],
				[url],
			)
}

const nextStep = (
	h: H,
	options: Readonly<{
		title: string
		description: string
		actions: ReadonlyArray<Html>
		extra?: ReadonlyArray<Html>
	}>,
): Html =>
	panel(h, {}, [
		h.div(
			[h.Class("flex flex-col gap-3 p-4")],
			[
				h.div(
					[h.Class("flex flex-col gap-1")],
					[
						h.h3([h.Class("text-sm font-medium")], [options.title]),
						h.p([h.Class("text-xs text-muted-foreground")], [options.description]),
					],
				),
				h.div([h.Class("flex flex-wrap gap-2")], options.actions),
				...(options.extra ?? []),
			],
		),
	])

export const liveView = (h: H, model: Model, page: V2StatusPage): Html => {
	const url = publicUrl(model.publicBaseUrl, page.slug)
	const hasToken = page.break_glass_token_suffix !== null
	return h.div(
		[h.Class("mx-auto flex w-full max-w-2xl flex-col gap-8 py-6")],
		[
			h.div(
				[h.Class("flex flex-col gap-2")],
				[
					h.span(
						[h.Class("flex items-center gap-2 text-severity-ok")],
						[icon(h, "CircleCheckIcon", { size: 18 }), eyebrow(h, {}, ["Published"])],
					),
					h.h2([h.Class("text-xl font-semibold tracking-tight")], [`${page.name} is live`]),
					h.p(
						[h.Class("text-sm text-muted-foreground")],
						[
							page.draft
								? "Publishing. It goes public as soon as the publish lands."
								: "Visitors can read it now. Changes you make go out within a minute.",
						],
					),
				],
			),
			url === null
				? h.div(
						[h.Class("flex flex-col gap-1.5")],
						[
							h.span([h.Class("text-xs text-muted-foreground")], ["Public address"]),
							h.p(
								[
									h.Class(
										"rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground",
									),
								],
								[NO_DOMAIN_NOTE],
							),
						],
					)
				: h.div(
						[h.Class("flex flex-col gap-2 sm:flex-row sm:items-end")],
						[
							h.div(
								[h.Class("min-w-0 flex-1")],
								[
									copyableField(h, {
										id: "status-page-public-url",
										label: "Public address",
										value: url,
										copyLabel: "public address",
										copy: model.urlCopy,
										toCopyMessage: (message) => Message.GotUrlCopyMessage({ message }),
									}),
								],
							),
							linkButton(
								h,
								{
									size: "sm",
									variant: "outline",
									href: url,
									attributes: [h.Target("_blank"), h.Rel("noopener")],
								},
								[icon(h, "ExternalLinkIcon"), "Open"],
							),
						],
					),
			h.section(
				[h.AriaLabelledBy("status-page-next-steps"), h.Class("flex flex-col gap-3")],
				[
					eyebrow(h, { as: "h2", attributes: [h.Id("status-page-next-steps")] }, ["Next steps"]),
					nextStep(h, {
						title: "Get a break-glass token",
						description:
							"If Maple itself is down, post updates straight to the page with it. Shown once; keep it in your password manager.",
						actions: model.isAdmin
							? [
									button(
										h,
										{
											size: "sm",
											variant: "outline",
											isLoading:
												model.isChangingBreakGlass &&
												model.breakGlassAction === "rotate",
											attributes: [h.OnClick(Message.ClickedRotateToken())],
										},
										[
											icon(h, "KeyIcon"),
											hasToken ? "Replace token" : "Get break-glass token",
										],
									),
								]
							: [
									h.p(
										[h.Class("text-xs text-muted-foreground")],
										["Ask an org admin to issue one."],
									),
								],
						extra: revealedToken(h, model),
					}),
					nextStep(h, {
						title: "Connect an agent",
						description:
							"Agents read and change the page as one JSON document through the API or Maple's MCP server, and post incidents the same way.",
						actions: [
							linkButton(
								h,
								{ size: "sm", variant: "outline", href: statusPageHref(page.id, "json") },
								[icon(h, "BracketsCurlyIcon"), "Page JSON"],
							),
							linkButton(
								h,
								{
									size: "sm",
									variant: "ghost",
									href: `${apiPublicUrl}/v2/docs`,
									attributes: [h.Target("_blank"), h.Rel("noopener")],
								},
								[icon(h, "ExternalLinkIcon"), "API docs"],
							),
						],
					}),
				],
			),
			h.div(
				[h.Class("flex justify-end border-t pt-4")],
				[
					linkButton(h, { size: "sm", href: statusPageHref(page.id) }, [
						"Open the editor",
						icon(h, "ArrowRightIcon"),
					]),
				],
			),
		],
	)
}
