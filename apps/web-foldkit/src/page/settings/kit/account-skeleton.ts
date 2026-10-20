import type { Html, HtmlBuilder } from "foldkit/html"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "../../../ui/empty"
import { icon } from "../../../ui/icon"
import { panel } from "../../../ui/panel"
import { skeleton } from "../../../ui/skeleton"
import { settingsSections } from "./section"

// `AccountSectionSkeleton`: what a settings or account section shows while its Clerk resource loads.

export const accountSectionSkeleton = <M>(h: HtmlBuilder<M>, children?: ReadonlyArray<Html>): Html =>
	settingsSections(h, "standard", [
		h.div(
			[h.Class("flex flex-col gap-3")],
			[
				h.div([h.Class("space-y-1.5")], [skeleton(h, "h-4 w-32"), skeleton(h, "h-4 w-64")]),
				panel(h, { padded: true }, children ?? [skeleton(h, "h-9 w-full")]),
			],
		),
	])

/** The "No organization" empty state the organization tabs show without an active org. */
export const noOrganization = <M>(h: HtmlBuilder<M>, description: string): Html =>
	empty(h, [
		emptyHeader(h, [
			emptyMedia(h, {}, [icon(h, "UserIcon", { size: 20 })]),
			emptyTitle(h, ["No organization"]),
			emptyDescription(h, [description]),
		]),
	])
