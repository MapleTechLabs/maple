import { AlertRuleId } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { alertsSectionRoute, AppRoute, hrefOf } from "../../../route"
import type { AlertRuleSearch, AlertsCreateSearch, AlertsHubSearch, AlertsTab } from "../../../route/search"

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)

/** A rule's page. Derived rows carry the id as a plain string; one that is not a rule id links home. */
export const ruleHref = (rawRuleId: string, search: typeof AlertRuleSearch.Type = {}): string =>
	Option.match(decodeRuleId(rawRuleId), {
		onNone: () => hrefOf(AppRoute.Alerts({ search: {} })),
		onSome: (ruleId) => hrefOf(AppRoute.AlertRule({ ruleId, search })),
	})

export const incidentHref = (incidentId: string): string =>
	hrefOf(AppRoute.AlertIncident({ incidentId, search: {} }))

/** A hub section's URL with the hub's filters; the Inbox by default. */
export const alertsHref = (search: typeof AlertsHubSearch.Type, tab: AlertsTab = "inbox"): string =>
	hrefOf(alertsSectionRoute(tab, search))

export const createHref = (search: typeof AlertsCreateSearch.Type): string =>
	hrefOf(AppRoute.AlertsCreate({ search }))
