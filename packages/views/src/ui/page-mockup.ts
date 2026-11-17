import { Option, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { hstack, vstack } from "./stack"
import { typography } from "./typography"

// Drawings of where a page shows up outside itself: a browser tab and a search result.

/** The tab's icon: the favicon at an https URL, else the name's first letter. */
const tabIcon = <M>(h: HtmlBuilder<M>, iconUrl: string | null, title: string): Html =>
	iconUrl !== null && Str.startsWith("https://")(iconUrl)
		? h.img([h.Src(iconUrl), h.Alt(""), h.Class("size-3.5 shrink-0 rounded-xs object-contain")])
		: h.span(
				[
					h.AriaHidden(true),
					h.Class(
						"grid size-3.5 shrink-0 place-items-center rounded-xs bg-foreground text-2xs font-semibold text-background",
					),
				],
				[Str.toUpperCase(Option.getOrElse(Str.charAt(Str.trim(title), 0), () => ""))],
			)

/**
 * `BrowserTabMockup`: a browser's tab strip (favicon, title, close) and address bar over what the
 * tab shows, for a preview of a page's tab title, icon and address.
 */
export const browserTabMockup = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; iconUrl: string | null; address: string | null }>,
	children: ReadonlyArray<Html>,
): Html =>
	vstack(h, { className: "overflow-hidden rounded-lg border bg-surface-sunken" }, [
		hstack(h, { gap: "2", className: "px-2 pt-2 pb-1.5", attributes: [h.AriaHidden(true)] }, [
			hstack(
				h,
				{ gap: "2", shrink: true, className: "max-w-56 rounded-md bg-background px-2.5 py-1" },
				[
					tabIcon(h, options.iconUrl, options.title),
					typography(h, { size: "xs", truncate: true }, [options.title]),
					icon(h, "XmarkIcon", { size: 12, className: "shrink-0 text-muted-foreground" }),
				],
			),
			...(options.address === null
				? []
				: [
						hstack(
							h,
							{
								gap: "1.5",
								grow: true,
								shrink: true,
								className: "rounded-md bg-background px-2.5 py-1",
							},
							[
								icon(h, "LockIcon", {
									size: 12,
									className: "shrink-0 text-muted-foreground",
								}),
								typography(h, { size: "xs", tone: "muted", mono: true, truncate: true }, [
									options.address,
								]),
							],
						),
					]),
		]),
		...children,
	])

/** `SearchResultMockup`: a page as a search engine or link preview lists it: address, title, description. */
export const searchResultMockup = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ address: string; title: string; description: string | null }>,
): Html =>
	vstack(h, { gap: "1", className: "rounded-lg border bg-card px-4 py-3" }, [
		typography(h, { size: "xs", tone: "muted", truncate: true }, [options.address]),
		typography(h, { size: "base", className: "text-info-foreground", truncate: true }, [options.title]),
		typography(h, { size: "sm", tone: options.description === null ? "muted" : "soft", as: "p" }, [
			options.description ?? "No description: search engines pick text from the page.",
		]),
	])
