import type { AuditTrailCategory, AuditTrailOutcome, AuditTrailProvider } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import { Array as Arr, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { Model, Search } from "./model"

// What the audit log shows of an event: the names of platforms, categories and outcomes, who
// acted and on what. A value this build does not know shows as itself.

export const PROVIDER_LABEL = { maple: "Maple" } satisfies Record<AuditTrailProvider, string>

export const CATEGORY_LABEL = {
	authentication: "Authentication",
	membership: "Membership",
	permission: "Permissions",
	credential: "Credentials",
	configuration: "Configuration",
	resource: "Resources",
	data_access: "Data access",
	billing: "Billing",
	other: "Other",
} satisfies Record<AuditTrailCategory, string>

export const OUTCOME_LABEL = {
	success: "Succeeded",
	failure: "Failed",
	denied: "Denied",
	unknown: "Unknown",
} satisfies Record<AuditTrailOutcome, string>

const labelOf =
	(labels: Readonly<Record<string, string>>) =>
	(value: string): string =>
		Rec.get(labels, value).pipe((label) => (label._tag === "Some" ? label.value : value))

export const providerLabel = labelOf(PROVIDER_LABEL)
export const categoryLabel = labelOf(CATEGORY_LABEL)
export const outcomeLabel = labelOf(OUTCOME_LABEL)

const ACTOR_TYPE_LABEL = {
	service: "Service",
	system: "System",
	unknown: "Unknown actor",
} as const

/** Who acted: their name, else email, else id, else what kind of actor it was. */
export const actorText = (event: AuditTrailEntry): string =>
	event.actor.name ?? event.actor.email ?? event.actor.id ?? labelOf(ACTOR_TYPE_LABEL)(event.actor.type)

/** A second line under the actor when the first is a name: the email or id that tells two apart. */
export const actorDetail = (event: AuditTrailEntry): string | null =>
	event.actor.name === null ? null : (event.actor.email ?? event.actor.id)

/** What was acted on: its name or id, null when the event names nothing. */
export const targetText = (event: AuditTrailEntry): string | null => event.target.name ?? event.target.id

/** An outcome worth a mark in the list: a success is the unmarked case. */
export const isRefused = (event: AuditTrailEntry): boolean =>
	event.outcome === "denied" || event.outcome === "failure"

export const isFiltered = (search: Search): boolean =>
	search.provider !== undefined ||
	search.category !== undefined ||
	search.outcome !== undefined ||
	search.actor !== undefined

/** Every event loaded so far, newest first; null until the first page answers. */
export const eventsOf = (
	model: Pick<Model, "firstPage" | "laterPages">,
): ReadonlyArray<AuditTrailEntry> | null =>
	AsyncData.matchData(model.firstPage.data, {
		onEmpty: () => null,
		onFailure: () => null,
		onData: (first) => {
			// A page boundary can repeat an event the table had not merged when the page was read.
			const seen = new Set<string>()
			return Arr.filter(
				[...first.events, ...Arr.flatMap(model.laterPages.pages, (page) => page.events)],
				(event) => !seen.has(event.id) && seen.add(event.id) !== undefined,
			)
		},
	})
