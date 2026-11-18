import type { V2StatusPage } from "@maple/domain/http/v2"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyableField } from "@maple/views/ui/copyable-field"
import { hstack, vstack } from "@maple/views/ui/stack"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { publicPageLink, statusPageViewHref } from "../shared/commands"
import { openPreviewButton, openPublicPageButton } from "../shared/open-page"
import { Message } from "./message"
import type { Model } from "./model"
import { pageUrlOf } from "./update-domain"

// Where the page is read, in full: the header's line, and the block on the live screen and in Who can view.

type H = HtmlBuilder<Message>

/** In place of a link that would not resolve: the stage has no status domain. */
export const NO_DOMAIN_NOTE = "Public address appears once a status domain is configured"

/** The header's address: a link to the public page, or the note while there is no status domain. */
export const addressLine = (h: H, model: Model, page: V2StatusPage): Html => {
	if (page.visibility === "internal")
		return typography(h, { size: "xs" }, [
			textLink(h, { href: statusPageViewHref(page.id), tone: "muted" }, [
				"Internal: only members can read it, in Maple",
			]),
		])
	const url = pageUrlOf(model, page)
	if (url === null) return typography(h, { size: "xs", tone: "muted" }, [NO_DOMAIN_NOTE])
	// A draft is never published, so its address does not resolve yet: text, not a link.
	if (page.draft) return typography(h, { size: "xs", tone: "muted", mono: true }, [url])
	return typography(h, { size: "xs" }, [
		textLink(
			h,
			{ href: url, tone: "muted", isMono: true, attributes: [h.Target("_blank"), h.Rel("noopener")] },
			[url],
		),
	])
}

/** Where the page is read: its full public address, or for an internal page the dev preview. */
export const addressBlock = (h: H, model: Model, page: V2StatusPage): Html => {
	if (page.visibility === "internal")
		return hstack(h, { gap: "3", justify: "between", align: "center", wrap: true }, [
			typography(h, { size: "sm", tone: "muted", as: "p" }, [
				"Not served publicly: members read it in Maple.",
			]),
			openPreviewButton(h, page.id),
		])
	const url = pageUrlOf(model, page)
	if (url === null)
		return vstack(h, { gap: "1.5" }, [
			typography(h, { size: "xs", tone: "muted" }, ["Public address"]),
			h.p(
				[h.Class("rounded-md border border-dashed px-3 py-2 text-sm text-muted-foreground")],
				[NO_DOMAIN_NOTE],
			),
		])
	return h.div(
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
			openPublicPageButton(h, publicPageLink(page, url)),
		],
	)
}
