import type { Html, HtmlBuilder } from "foldkit/html"
import {
	breadcrumb,
	breadcrumbEllipsis,
	breadcrumbItem,
	breadcrumbLink,
	breadcrumbList,
	breadcrumbPage,
	breadcrumbSeparator,
} from "../../ui/breadcrumb"
import { button } from "../../ui/button"
import type { CopyStatus } from "../../ui/copy-button"
import { eyebrow } from "../../ui/eyebrow"
import { pageHeader, pageHeaderActions, pageLayoutRoot } from "../../ui/page-layout"
import { spinner } from "../../ui/spinner"
import { icon } from "../../ui/icon"
import { marker, markerContent, markerIcon } from "../../ui/marker"
import { avatarPlaceholder } from "./content-placeholders"
import { kitRow, kitSection } from "./kit-layout"
import {
	conversationSection,
	scrollAreaSection,
	settingRowSection,
	traceSection,
	truncationSection,
} from "./content-sections-more"

export interface ContentInputs<M> {
	readonly copyStatus: CopyStatus
	readonly onCopy: (value: string) => M
	readonly calendar: Html
}

const pageLayoutSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Page layout header", [
		h.div(
			[h.Class("overflow-hidden rounded-md border")],
			[
				pageLayoutRoot(h, [
					pageHeader(
						h,
						{ title: "Services", description: "Every service that sent spans in the selected window." },
						[pageHeaderActions(h, [button(h, { variant: "outline", size: "sm" }, ["Export"])])],
					),
				]),
			],
		),
	])

const breadcrumbSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Eyebrow and breadcrumb", [
		kitRow(h, undefined, [
			eyebrow(h, {}, ["Default eyebrow"]),
			eyebrow(h, { variant: "label" }, ["Label eyebrow"]),
		]),
		breadcrumb(h, undefined, [
			breadcrumbList(h, undefined, [
				breadcrumbItem(h, {}, [breadcrumbLink(h, { href: "#dashboards" }, ["Dashboards"])]),
				breadcrumbSeparator(h, undefined),
				breadcrumbItem(h, {}, [breadcrumbEllipsis(h)]),
				breadcrumbSeparator(h, undefined),
				breadcrumbItem(h, {}, [breadcrumbPage(h, undefined, ["Checkout latency"])]),
			]),
		]),
	])

const markerSection = <M>(h: HtmlBuilder<M>): Html =>
	kitSection(h, "Avatar, spinner, marker", [
		kitRow(h, undefined, [
			avatarPlaceholder(h, "DM"),
			avatarPlaceholder(h, "AB", "size-6"),
			spinner(h),
			spinner(h, "size-6"),
		]),
		h.div(
			[h.Class("flex max-w-md flex-col gap-3")],
			[
				marker(h, {}, [
					markerIcon(h, [icon(h, "BellIcon")]),
					markerContent(h, ["Alert fired at 12:00 UTC"]),
				]),
				marker(h, { variant: "separator" }, [markerContent(h, ["Yesterday"])]),
				marker(h, { variant: "border" }, [markerContent(h, ["Border marker"])]),
			],
		),
	])

export const contentSections = <M>(h: HtmlBuilder<M>, inputs: ContentInputs<M>): ReadonlyArray<Html> => [
	pageLayoutSection(h),
	breadcrumbSection(h),
	markerSection(h),
	conversationSection(h),
	traceSection(h),
	truncationSection(h, inputs),
	settingRowSection(h),
	scrollAreaSection(h),
	kitSection(h, "Calendar", [inputs.calendar]),
]
