import type { V2StatusPage } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { apiPublicUrl } from "../../../lib/services/common/api-base-url"
import { button, linkButton } from "../../../ui/button"
import { copyableField } from "../../../ui/copyable-field"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { heading } from "../../../ui/heading"
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
	if (url === null) return h.span([h.Class("text-xs text-muted-foreground")], [NO_DOMAIN_NOTE])
	// A draft is never published, so its address does not resolve yet: text, not a link.
	if (page.draft) return h.span([h.Class("font-mono text-xs text-muted-foreground")], [url])
	return h.a(
		[
			h.Href(url),
			h.Target("_blank"),
			h.Rel("noopener"),
			h.Class(
				"font-mono text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline active:text-foreground active:underline",
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
						heading(h, { level: 3, variant: "subsection" }, [options.title]),
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
					// A draft reached by link, or one whose publish has not been read back yet, is not live.
					page.draft
						? eyebrow(h, {}, ["Draft"])
						: h.span(
								[h.Class("flex items-center gap-2 text-severity-ok")],
								[icon(h, "CircleCheckIcon", { size: 18 }), eyebrow(h, {}, ["Published"])],
							),
					heading(h, { level: 2, variant: "title" }, [
						page.draft ? `${page.name} is not public yet` : `${page.name} is live`,
					]),
					h.p(
						[h.Class("text-sm text-muted-foreground")],
						[
							page.draft
								? "Visitors can't see it until it is published."
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
							...(page.draft
								? []
								: [
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
									]),
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
