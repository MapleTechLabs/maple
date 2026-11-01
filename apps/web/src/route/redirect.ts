import type { OrganizationFeatureFlags } from "@maple/domain/organization-feature-flags"
import { Option, Schema } from "effect"
import { AppRoute } from "./app-route"
import { hrefOf } from "./routers"
import { DATA_INTEGRATIONS } from "./data-integrations"
import { ErrorsSearch } from "./search"

/** Where a route sends the browser instead of rendering, and whether it replaces history. */
export const Redirect = Schema.Struct({ url: Schema.String, isReplace: Schema.Boolean })
export type Redirect = typeof Redirect.Type

const VIEW_FOR_WORKFLOW_STATE = new Map<unknown, string>([
	["triage", "open"],
	["regressed", "open"],
	["todo", "open"],
	["in_progress", "open"],
	["in_review", "open"],
	["verifying", "closed"],
	["done", "closed"],
	["cancelled", "closed"],
	["wontfix", "closed"],
	["all", "all"],
])

const decodeErrorsSearch = Schema.decodeUnknownOption(ErrorsSearch)

/** Old issues-list links carry `workflowState` and `severity`; the hub defaults to Open and all severities. */
const errorsSearchOf = ({ search }: typeof AppRoute.ErrorIssues.Type): typeof ErrorsSearch.Type => {
	const view = VIEW_FOR_WORKFLOW_STATE.get(search.workflowState)
	return Option.getOrElse(
		decodeErrorsSearch({
			view: view === "open" ? undefined : view,
			severity: search.severity === "all" ? undefined : search.severity,
		}),
		() => ({}),
	)
}

const DATA_INTEGRATION_IDS: ReadonlySet<string> = new Set(DATA_INTEGRATIONS)

const redirect = (to: AppRoute, isReplace: boolean) =>
	Option.some(Redirect.make({ url: hrefOf(to), isReplace }))

/** Redirects of retired paths (connectors, developer, infra, errors/issues, alerts status pages) and moved integrations. */
export const routeRedirect = (route: AppRoute): Option.Option<Redirect> =>
	AppRoute.matchOrElse<Option.Option<Redirect>>(
		route,
		{
			Connectors: ({ search }) =>
				redirect(
					search.tab === "prometheus" || search.tab === "cloudflare"
						? AppRoute.SourcesNew({ search: { integration: search.tab } })
						: AppRoute.Integrations({ search: {} }),
					false,
				),
			/**
			 * Old links and OAuth returns to a data integration's page open its step under Sources.
			 * Hazel's app still links to the id its connector replaced.
			 */
			Integrations: ({ search }) =>
				search.integration !== undefined && DATA_INTEGRATION_IDS.has(search.integration)
					? redirect(AppRoute.SourcesNew({ search: { integration: search.integration } }), true)
					: search.integration === "hazel"
						? redirect(AppRoute.Integrations({ search: { integration: "chat-hazel" } }), true)
						: Option.none(),
			Developer: ({ search }) =>
				redirect(
					AppRoute.Settings({
						search: { tab: search.tab === "ingestion" ? "ingestion" : "keys" },
					}),
					true,
				),
			InfraDiscover: () => redirect(AppRoute.Infra({ search: {} }), true),
			InfraLegacyHost: ({ hostName }) => redirect(AppRoute.InfraHost({ hostName, search: {} }), true),
			AlertIncidentsIndex: () => redirect(AppRoute.Alerts({ search: {} }), true),
			/** Status pages left the Alerts hub for their own sidebar entry. */
			Alerts: ({ search }) =>
				search.tab === "status-pages" ? redirect(AppRoute.StatusPages(), true) : Option.none(),
			AlertsStatusPage: ({ pageId, search }) =>
				redirect(
					AppRoute.StatusPage({
						pageId,
						search:
							search.tab === "settings" || search.tab === "json" ? { view: search.tab } : {},
					}),
					true,
				),
			RecommendationsIndex: () => redirect(AppRoute.Settings({ search: { tab: "ingestion" } }), true),
			InfraKubernetes: ({ search }) => redirect(AppRoute.InfraKubernetesPods({ search }), true),
			ErrorIssues: (issues) => redirect(AppRoute.Errors({ search: errorsSearchOf(issues) }), true),
		},
		() => Option.none(),
	)

const isStatusPageRoute = AppRoute.isAnyOf(["StatusPages", "StatusPageNew", "StatusPage"])

/** A route an org outside its rollout cannot open goes home (`/status-pages` without `statusPages`). */
export const flaggedRouteRedirect = (
	route: AppRoute,
	flags: Pick<OrganizationFeatureFlags, "statusPages">,
): Option.Option<Redirect> =>
	!flags.statusPages && isStatusPageRoute(route)
		? redirect(AppRoute.Home({ search: {} }), true)
		: Option.none()
