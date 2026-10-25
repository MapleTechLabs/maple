import { cn } from "@maple/ui/lib/utils"
import {
	breadcrumbEllipsisIconStyles,
	breadcrumbEllipsisLabelStyles,
	breadcrumbItemStyles,
	breadcrumbLinkStyles,
	breadcrumbListStyles,
	breadcrumbPageStyles,
	breadcrumbSeparatorStyles,
} from "@maple/ui/styles/ui/breadcrumb"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

type Children = ReadonlyArray<Html | string>

export const breadcrumb = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.nav(
		[
			h.AriaLabel("breadcrumb"),
			...(className ? [h.Class(className)] : []),
			h.DataAttribute("slot", "breadcrumb"),
		],
		children,
	)

export const breadcrumbList = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.ol([h.Class(cn(breadcrumbListStyles, className)), h.DataAttribute("slot", "breadcrumb-list")], children)

export const breadcrumbItem = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; title?: string }>,
	children: Children,
): Html =>
	h.li(
		[
			h.Class(cn(breadcrumbItemStyles, options.className)),
			h.DataAttribute("slot", "breadcrumb-item"),
			...(options.title === undefined ? [] : [h.Title(options.title)]),
		],
		children,
	)

/** `<BreadcrumbLink render={<Link to />}>`. */
export const breadcrumbLink = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{ className?: string; href: string }>,
	children: Children,
): Html =>
	h.a(
		[
			h.Href(options.href),
			h.Class(cn(breadcrumbLinkStyles, options.className)),
			h.DataAttribute("slot", "breadcrumb-link"),
		],
		children,
	)

export const breadcrumbPage = <Message>(
	h: HtmlBuilder<Message>,
	className: string | undefined,
	children: Children,
): Html =>
	h.span(
		[
			h.AriaCurrent("page"),
			h.Class(cn(breadcrumbPageStyles, className)),
			h.DataAttribute("slot", "breadcrumb-page"),
		],
		children,
	)

export const breadcrumbSeparator = <Message>(h: HtmlBuilder<Message>, className: string | undefined): Html =>
	h.li(
		[
			h.AriaHidden(true),
			h.Class(cn(breadcrumbSeparatorStyles, className)),
			h.DataAttribute("slot", "breadcrumb-separator"),
			h.Role("presentation"),
		],
		[icon(h, "ChevronRightIcon")],
	)

export const breadcrumbEllipsis = <Message>(h: HtmlBuilder<Message>, className?: string): Html =>
	h.span(
		[
			h.AriaHidden(true),
			...(className === undefined ? [] : [h.Class(className)]),
			h.DataAttribute("slot", "breadcrumb-ellipsis"),
			h.Role("presentation"),
		],
		[
			icon(h, "DotsIcon", { className: breadcrumbEllipsisIconStyles }),
			h.span([h.Class(breadcrumbEllipsisLabelStyles)], ["More"]),
		],
	)
