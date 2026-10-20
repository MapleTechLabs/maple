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

/** Redirects of retired paths (connectors, developer, infra, errors/issues) and moved integrations. */
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
			/** Old links and OAuth returns to a data integration's page open its step under Sources. */
			Integrations: ({ search }) =>
				search.integration !== undefined && DATA_INTEGRATION_IDS.has(search.integration)
					? redirect(AppRoute.SourcesNew({ search: { integration: search.integration } }), true)
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
			InfraKubernetes: ({ search }) => redirect(AppRoute.InfraKubernetesPods({ search }), true),
			ErrorIssues: (issues) => redirect(AppRoute.Errors({ search: errorsSearchOf(issues) }), true),
		},
		() => Option.none(),
	)
