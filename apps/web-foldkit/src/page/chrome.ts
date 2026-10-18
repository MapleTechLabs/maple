import { pageContentStyles } from "@maple/ui/styles/ui/page-layout"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, isPublicRoute } from "../route"
import type { BreadcrumbEntry } from "../shell"
import { pageBody } from "./kit/dashboard-page"

/**
 * Signed-in routes legacy renders without `DashboardLayout`: onboarding and auth handoffs with
 * their own layouts and the not-found screen. `/chat` keeps the shell, without its top bar (`view.ts`).
 */
const isBareRoute = AppRoute.isAnyOf([
	"CliLogin",
	"McpAuthorize",
	"QuickStart",
	"SelectPlan",
	"NotFound",
])

export const rendersShell = (route: AppRoute): boolean => !isPublicRoute(route) && !isBareRoute(route)

/** The trail each page passes to `DashboardPage`; unported pages show their route tag. */
export const breadcrumbsOf = (route: AppRoute): ReadonlyArray<BreadcrumbEntry> =>
	AppRoute.matchOrElse<ReadonlyArray<BreadcrumbEntry>>(
		route,
		{ Home: () => [{ label: "Overview" }] },
		() => [{ label: route._tag }],
	)

/** `PageLayout.Content` holding a not-yet-ported page: its route tag on the page background. */
export const placeholderContent = <Message>(h: HtmlBuilder<Message>, route: AppRoute): Html =>
	pageBody(h, [placeholderMain(h, route)])

const placeholderMain = <Message>(h: HtmlBuilder<Message>, route: AppRoute): Html =>
	h.main(
		[h.Class(pageContentStyles), h.DataAttribute("slot", "page-content"), h.Id("main-content")],
		[
			h.div(
				[h.Class("flex flex-col gap-2 p-4")],
				[
					h.h1([h.Class("font-display text-xl font-semibold")], [route._tag]),
					h.p([h.Class("font-mono text-muted-foreground text-xs")], ["Not ported yet"]),
				],
			),
		],
	)
