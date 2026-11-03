import { AlertRuleId } from "@maple/domain/http"
import { Option, Schema } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import type { AlertRuleSearch, AlertsCreateSearch, AlertsSearch } from "../../../route/search"

const decodeRuleId = Schema.decodeUnknownOption(AlertRuleId)

/** A rule's page. Derived rows carry the id as a plain string; one that is not a rule id links home. */
export const ruleHref = (rawRuleId: string, search: typeof AlertRuleSearch.Type = {}): string =>
	Option.match(decodeRuleId(rawRuleId), {
		onNone: () => hrefOf(AppRoute.Alerts({ search: {} })),
		onSome: (ruleId) => hrefOf(AppRoute.AlertRule({ ruleId, search })),
	})

export const incidentHref = (incidentId: string): string =>
	hrefOf(AppRoute.AlertIncident({ incidentId, search: {} }))

export const alertsHref = (search: typeof AlertsSearch.Type): string => hrefOf(AppRoute.Alerts({ search }))

export const createHref = (search: typeof AlertsCreateSearch.Type): string =>
	hrefOf(AppRoute.AlertsCreate({ search }))
