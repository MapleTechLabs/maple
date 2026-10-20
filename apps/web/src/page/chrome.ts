import { pageContentStyles } from "@maple/ui/styles/ui/page-layout"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, isPublicRoute } from "../route"
import type { BreadcrumbEntry } from "../shell"
import { pageBody } from "./kit/dashboard-page"
import { resolveLegacySettingsTab } from "./settings/nav"

/**
 * Signed-in routes rendered without `DashboardLayout`: onboarding and auth handoffs with
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

/**
 * A retired settings tab only redirects, with no `DashboardLayout`, so the top bar's pill is not
 * mounted and the redirect re-reads nothing.
 */
export const isRedirectOnlyRoute = (route: AppRoute): boolean =>
	route._tag === "Settings" && Option.isSome(resolveLegacySettingsTab(route.search.tab))

/** The trail each page passes to `DashboardPage`; pages without one show their route tag. */
export const breadcrumbsOf = (route: AppRoute): ReadonlyArray<BreadcrumbEntry> =>
	AppRoute.matchOrElse<ReadonlyArray<BreadcrumbEntry>>(
		route,
		{ Home: () => [{ label: "Overview" }] },
		() => [{ label: route._tag }],
	)

/** `PageLayout.Content` for a route without a page: its route tag on the page background. */
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
