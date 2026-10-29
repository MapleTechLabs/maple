import { pageContentStyles } from "@maple/ui/styles/ui/page-layout"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, isPublicRoute } from "../route"
import type { BreadcrumbEntry } from "../shell"
import { skeleton, skeletonList } from "../ui/skeleton"
import { dashboardPage, pageBody } from "./kit/dashboard-page"
import { resourceNotFound } from "./kit/resource-not-found"
import { resolveLegacySettingsTab } from "./settings/nav"

/**
 * Signed-in routes rendered without `DashboardLayout`: onboarding and auth handoffs with
 * their own layouts.
 */
const isBareRoute = AppRoute.isAnyOf(["CliLogin", "McpAuthorize", "QuickStart", "SelectPlan"])

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
		{ Home: () => [{ label: "Overview" }], NotFound: () => [{ label: "Page not found" }] },
		() => [{ label: route._tag }],
	)

/**
 * `PageLayout.Content` while the page has no slot or context yet (no org open, a plan-gate
 * redirect in flight): a page skeleton, so nothing but loading ever paints there.
 */
export const placeholderContent = <Message>(h: HtmlBuilder<Message>): Html =>
	pageBody(h, [
		h.main(
			[
				h.Class(pageContentStyles),
				h.DataAttribute("slot", "page-content"),
				h.Id("main-content"),
				h.AriaBusy(true),
				h.AriaLabel("Loading"),
			],
			[
				h.div(
					[h.Class("flex flex-col gap-4 p-4")],
					[skeleton(h, "h-7 w-48"), skeletonList(h, { rows: 6, rowClassName: "h-10", gap: "2" })],
				),
			],
		),
	])

/** An unknown path inside the shell: the not-found body with a way back to Overview. */
export const notFoundContent = <Message>(h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, {}, [
		resourceNotFound(h, {
			title: "Page not found",
			description: "This page doesn't exist or was moved.",
			back: { href: "/", label: "Back to Overview" },
		}),
	])
