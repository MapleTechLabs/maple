import type { V2StatusPage } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { apiPublicUrl } from "../../../platform/api-base-url"
import { button, linkButton } from "@maple/views/ui/button"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { icon } from "@maple/views/ui/icon"
import { panel } from "@maple/views/ui/panel"
import { heading } from "@maple/views/ui/heading"
import { statusPageHref } from "../shared/commands"
import { addressBlock } from "./view-address"
import { Message } from "./message"
import { canBreakGlass, type Model } from "./model"
import { revealedToken } from "./view-settings"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"

// Right after Publish: the page is live, where it lives, and the two things worth doing next.

type H = HtmlBuilder<Message>

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
		vstack(h, { gap: "3", className: "p-4" }, [
			vstack(h, { gap: "1" }, [
				heading(h, { level: 3, variant: "subsection" }, [options.title]),
				typography(h, { size: "xs", tone: "muted", as: "p" }, [options.description]),
			]),
			hstack(h, { gap: "2", align: "stretch", wrap: true }, options.actions),
			...(options.extra ?? []),
		]),
	])

const breakGlassStep = (h: H, model: Model, page: V2StatusPage): Html =>
	nextStep(h, {
		title: "Get a break-glass token",
		description:
			"If Maple itself is down, post updates straight to the page with it. Shown once; keep it in your password manager.",
		actions: canBreakGlass(model)
			? [
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isLoading: model.isChangingBreakGlass && model.breakGlassAction === "rotate",
							attributes: [h.OnClick(Message.ClickedRotateToken())],
						},
						[
							icon(h, "KeyIcon"),
							page.break_glass_token_suffix === null
								? "Get break-glass token"
								: "Replace token",
						],
					),
				]
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, ["Ask an org admin to issue one."])],
		extra: revealedToken(h, model),
	})

/** What the page is now, for whoever can read it: visitors, or only members for an internal page. */
const liveCopy = (page: V2StatusPage): string => {
	if (page.visibility === "internal") return "Only members of this organization can read it, in Maple."
	return page.draft
		? "Visitors can't see it until it is published."
		: "Visitors can read it now. Changes you make go out within a minute."
}

export const liveView = (h: H, model: Model, page: V2StatusPage): Html =>
	vstack(h, { gap: "8", className: "mx-auto w-full max-w-2xl py-6" }, [
		vstack(h, { gap: "2" }, [
			// A draft reached by link, or one whose publish has not been read back yet, is not live.
			page.draft
				? eyebrow(h, {}, ["Draft"])
				: hstack(h, { gap: "2", align: "center", as: "span", className: "text-success" }, [
						icon(h, "CircleCheckIcon", { size: 18 }),
						eyebrow(h, {}, ["Published"]),
					]),
			heading(h, { level: 2, variant: "title" }, [
				page.draft
					? `${page.name} is not ${page.visibility === "internal" ? "published" : "public"} yet`
					: `${page.name} is live`,
			]),
			typography(h, { size: "sm", tone: "muted", as: "p" }, [liveCopy(page)]),
		]),
		addressBlock(h, model, page),
		vstack(h, { gap: "3", as: "section", attributes: [h.AriaLabelledBy("status-page-next-steps")] }, [
			eyebrow(h, { as: "h2", attributes: [h.Id("status-page-next-steps")] }, ["Next steps"]),
			// Break-glass posts to the public address, which an internal page does not answer on.
			...(page.visibility === "internal" ? [] : [breakGlassStep(h, model, page)]),
			nextStep(h, {
				title: "Connect an agent",
				description:
					"Agents read and change the page as one JSON document through the API or Maple's MCP server, and post incidents the same way.",
				actions: [
					linkButton(
						h,
						{
							size: "sm",
							variant: "outline",
							href: statusPageHref(page.id, "settings", "advanced"),
						},
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
		]),
		hstack(h, { align: "stretch", justify: "end", className: "border-t pt-4" }, [
			linkButton(h, { size: "sm", href: statusPageHref(page.id) }, [
				"Open the editor",
				icon(h, "ArrowRightIcon"),
			]),
		]),
	])
