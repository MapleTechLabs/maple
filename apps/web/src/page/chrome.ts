import { Array as Arr, String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { AppRoute, isPublicRoute } from "../route"
import type { BreadcrumbEntry } from "../shell"
import { skeleton, skeletonList } from "@maple/views/ui/skeleton"
import { dashboardPage, pageBody, pageContent } from "./kit/dashboard-page"
import { resourceNotFound } from "./kit/resource-not-found"
import { vstack } from "@maple/views/ui/stack"

/**
 * Signed-in routes rendered without the dashboard shell: onboarding and auth handoffs with
 * their own layouts.
 */
const isBareRoute = AppRoute.isAnyOf(["CliLogin", "McpAuthorize", "QuickStart", "SelectPlan"])

export const rendersShell = (route: AppRoute): boolean => !isPublicRoute(route) && !isBareRoute(route)

/** The trail each page passes to the shell; pages without one show their route tag. */
export const breadcrumbsOf = (route: AppRoute): ReadonlyArray<BreadcrumbEntry> =>
	AppRoute.matchOrElse<ReadonlyArray<BreadcrumbEntry>>(
		route,
		{ Home: () => [{ label: "Overview" }], NotFound: () => [{ label: "Page not found" }] },
		() => [{ label: route._tag }],
	)

const APP_NAME = "Maple"

/** A crumb standing in for a name that has not loaded ("Loading…") names nothing yet. */
const isPendingLabel = (label: string) => Str.endsWith("…")(label)

/**
 * The tab title: the page's own name first, then its parent, so a row of narrow tabs still tells
 * them apart ("checkout-api · Services · Maple").
 */
export const documentTitleOf = (breadcrumbs: ReadonlyArray<BreadcrumbEntry>): string => {
	const names = Arr.filter(
		Arr.map(breadcrumbs, (crumb) => crumb.label),
		(label) => label !== "" && !isPendingLabel(label),
	)
	return Arr.join([...Arr.reverse(Arr.takeRight(names, 2)), APP_NAME], " · ")
}

/**
 * The page content while the page has no slot or context yet (no org open, a plan-gate
 * redirect in flight): a page skeleton, so nothing but loading ever paints there.
 */
export const placeholderContent = <Message>(h: HtmlBuilder<Message>): Html =>
	pageBody(h, [
		pageContent(
			h,
			[
				vstack(h, { gap: "4", className: "p-4" }, [
					skeleton(h, "h-7 w-48"),
					skeletonList(h, { rows: 6, rowClassName: "h-10", gap: "2" }),
				]),
			],
			[h.AriaBusy(true), h.AriaLabel("Loading")],
		),
	])

/** An unknown path inside the shell: the kit's not-found card under the page title. */
export const notFoundContent = <Message>(h: HtmlBuilder<Message>): Html =>
	dashboardPage(h, { title: "Page not found", gap: "sm" }, [
		resourceNotFound(h, {
			title: "The link may be out of date",
			description: "This page moved or never existed. Search with ⌘K, or start from Overview.",
			back: { href: "/", label: "Back to Overview" },
		}),
	])
