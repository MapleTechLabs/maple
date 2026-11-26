import type {
	AlertIncidentDocument,
	AlertIncidentEscalationDocument,
	AlertIncidentId,
	OrgId,
} from "@maple/domain/http"
import { Effect, Array as Arr } from "effect"
import type {
	AlertIncidentNextStepPeople,
	AlertIncidentPagesServiceApi,
} from "@maple/backend/services/alerts/AlertIncidentPagesService"
import type { AlertReadModelsServiceApi } from "@maple/backend/services/alerts/AlertReadModelsService"

/** Each incident's latest escalation run, and who its next step would page. */
export interface IncidentEscalations {
	readonly runOf: (incidentId: AlertIncidentId) => AlertIncidentEscalationDocument | undefined
	readonly nextStepPeopleOf: (incidentId: AlertIncidentId) => AlertIncidentNextStepPeople["people"]
}

/**
 * One escalation read for a whole page of incidents, never one per incident. Who is paged next is
 * read only for the runs still waiting on a step: unacknowledged open incidents with a chain.
 */
export const loadIncidentEscalations = (
	readModels: Pick<AlertReadModelsServiceApi, "listIncidentEscalations">,
	pages: Pick<AlertIncidentPagesServiceApi, "listNextStepPeople">,
	orgId: OrgId,
	docs: ReadonlyArray<AlertIncidentDocument>,
) =>
	Effect.gen(function* () {
		const escalations = yield* readModels.listIncidentEscalations(
			orgId,
			Arr.map(docs, (doc): AlertIncidentId => doc.id),
		)
		const byIncident = new Map(Arr.map(escalations, (row) => [row.incidentId, row]))
		const waiting = Arr.flatMap(docs, (doc): ReadonlyArray<AlertIncidentId> =>
			doc.status === "open" && doc.acknowledgedAt === null && byIncident.get(doc.id)?.nextStepAt != null
				? [doc.id]
				: [],
		)
		const people = yield* pages.listNextStepPeople(orgId, waiting)
		const peopleByIncident = new Map(Arr.map(people, (row) => [row.incidentId, row.people]))
		return {
			runOf: (incidentId) => byIncident.get(incidentId),
			nextStepPeopleOf: (incidentId) => peopleByIncident.get(incidentId) ?? [],
		} satisfies IncidentEscalations
	})
