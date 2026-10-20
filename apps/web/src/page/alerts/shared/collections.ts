import type {
	AlertDestinationRow,
	AlertIncidentRow,
	AlertRuleRow,
	AlertRuleStateRow,
} from "@maple/web-data/collections/alerts"
import type { Stream } from "effect"
import { type OrgCollectionSet, type OrgCollections, orgLive } from "../../../data/collections/org-collections"
import { liveQueryStream } from "../../../data/live-query"

// The four alert shapes as live streams (`useAlertRulesList`, `useAlertIncidentsList`,
// `useAlertDestinationsList` and the overview model's collection stores).

const fromSet = <A>(build: (set: OrgCollectionSet) => Stream.Stream<A>) =>
	(orgId: string): Stream.Stream<A, never, OrgCollections> =>
		orgLive(orgId, build)

/** `alert_rules`, newest edit first (the server's `listRules` order). */
export const ruleRows = <M>(orgId: string, toMessage: (rows: ReadonlyArray<AlertRuleRow>) => M) =>
	fromSet((set) =>
		liveQueryStream(
			(q) => q.from({ r: set.alertRules }).orderBy(({ r }) => r.updated_at, "desc"),
			(rows) => toMessage(rows),
		),
	)(orgId)

export const ruleStateRows = <M>(orgId: string, toMessage: (rows: ReadonlyArray<AlertRuleStateRow>) => M) =>
	fromSet((set) => liveQueryStream((q) => q.from({ s: set.alertRuleStates }), (rows) => toMessage(rows)))(orgId)

/** `alert_incidents`, latest trigger first. */
export const incidentRows = <M>(orgId: string, toMessage: (rows: ReadonlyArray<AlertIncidentRow>) => M) =>
	fromSet((set) =>
		liveQueryStream(
			(q) => q.from({ i: set.alertIncidents }).orderBy(({ i }) => i.last_triggered_at, "desc"),
			(rows) => toMessage(rows),
		),
	)(orgId)

/** `alert_destinations_v2`, newest edit first. */
export const destinationRows = <M>(orgId: string, toMessage: (rows: ReadonlyArray<AlertDestinationRow>) => M) =>
	fromSet((set) =>
		liveQueryStream(
			(q) => q.from({ d: set.alertDestinations }).orderBy(({ d }) => d.updated_at, "desc"),
			(rows) => toMessage(rows),
		),
	)(orgId)

