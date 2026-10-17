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
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { CHEVRON_RIGHT_PATHS, DOTS_PATHS, strokeIcon } from "./stroke-icons"

// Port of packages/ui/src/components/ui/breadcrumb.tsx.

type Children = ReadonlyArray<Html | string>

export const breadcrumb = <M>(h: HtmlBuilder<M>, children: Children): Html =>
	h.nav([h.AriaLabel("breadcrumb"), h.DataAttribute("slot", "breadcrumb")], children)

export const breadcrumbList = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.ol([h.Class(cn(breadcrumbListStyles, className)), h.DataAttribute("slot", "breadcrumb-list")], children)

export const breadcrumbItem = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.li([h.Class(cn(breadcrumbItemStyles, className)), h.DataAttribute("slot", "breadcrumb-item")], children)

/** `BreadcrumbLink`: an `<a>`; navigation attributes (href, OnClick) come from the caller. */
export const breadcrumbLink = <M>(
	h: HtmlBuilder<M>,
	attributes: ReadonlyArray<Attribute<M>>,
	children: Children,
	className?: string,
): Html =>
	h.a(
		[h.Class(cn(breadcrumbLinkStyles, className)), h.DataAttribute("slot", "breadcrumb-link"), ...attributes],
		children,
	)

export const breadcrumbPage = <M>(h: HtmlBuilder<M>, children: Children, className?: string): Html =>
	h.span(
		[
			h.AriaCurrent("page"),
			h.Class(cn(breadcrumbPageStyles, className)),
			h.DataAttribute("slot", "breadcrumb-page"),
		],
		children,
	)

export const breadcrumbSeparator = <M>(h: HtmlBuilder<M>, children?: Children, className?: string): Html =>
	h.li(
		[
			h.AriaHidden(true),
			h.Class(cn(breadcrumbSeparatorStyles, className)),
			h.DataAttribute("slot", "breadcrumb-separator"),
			h.Role("presentation"),
		],
		children ?? [strokeIcon(h, CHEVRON_RIGHT_PATHS)],
	)

export const breadcrumbEllipsis = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	h.span(
		[
			h.AriaHidden(true),
			...(className === undefined ? [] : [h.Class(className)]),
			h.DataAttribute("slot", "breadcrumb-ellipsis"),
			h.Role("presentation"),
		],
		[
			strokeIcon(h, DOTS_PATHS, { className: breadcrumbEllipsisIconStyles, strokeWidth: "3" }),
			h.span([h.Class(breadcrumbEllipsisLabelStyles)], ["More"]),
		],
	)
