import { Option, Schema } from "effect"
import { AppRoute } from "./app-route"
import { hrefOf } from "./routers"
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

const redirect = (to: AppRoute, isReplace: boolean) =>
	Option.some(Redirect.make({ url: hrefOf(to), isReplace }))

/** The `beforeLoad` redirects of legacy route files (connectors, developer, infra, errors/issues). */
export const routeRedirect = (route: AppRoute): Option.Option<Redirect> =>
	AppRoute.matchOrElse<Option.Option<Redirect>>(
		route,
		{
			Connectors: ({ search }) =>
				redirect(
					AppRoute.Integrations({
						search:
							search.tab === "prometheus" || search.tab === "cloudflare"
								? { integration: search.tab }
								: {},
					}),
					false,
				),
			Developer: ({ search }) =>
				redirect(
					AppRoute.Settings({
						search: { tab: search.tab === "ingestion" ? "ingestion" : "api-keys" },
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
