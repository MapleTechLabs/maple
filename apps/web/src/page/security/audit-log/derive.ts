import type { AuditTrailCategory, AuditTrailOutcome, AuditTrailProvider } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import type { Model, Search } from "./model"

// What the audit log shows of an event: the names of platforms, categories and outcomes, who acted
// and on what. A value this build does not know shows as itself.

export const PROVIDER_LABEL = {
	maple: "Maple",
	vercel: "Vercel",
	gcp: "Google Cloud",
} satisfies Record<AuditTrailProvider, string>

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

/** The outcomes worth filtering by. `unknown` is a platform that did not say, not something to look for. */
export const OUTCOME_FILTERS = [
	"success",
	"failure",
	"denied",
] as const satisfies ReadonlyArray<AuditTrailOutcome>

const ACTOR_TYPE_LABEL = {
	user: "User",
	service: "Service",
	system: "System",
	unknown: "Unknown actor",
} as const

/** The label for `value`, or the value itself when this build has no name for it. */
export const labelIn = (labels: Readonly<Record<string, string>>, value: string): string =>
	Option.getOrElse(Rec.get(labels, value), () => value)

export const providerLabel = (provider: string): string => labelIn(PROVIDER_LABEL, provider)
export const categoryLabel = (category: string): string => labelIn(CATEGORY_LABEL, category)
export const outcomeLabel = (outcome: string): string => labelIn(OUTCOME_LABEL, outcome)
export const actorTypeLabel = (type: string): string => labelIn(ACTOR_TYPE_LABEL, type)

/** Who acted: their name, else email, else id, else what kind of actor it was. */
export const actorText = (event: AuditTrailEntry): string =>
	event.actor.name ?? event.actor.email ?? event.actor.id ?? actorTypeLabel(event.actor.type)

/** A second line under the actor when the first is a name: the email or id that tells two apart. */
export const actorDetail = (event: AuditTrailEntry): string | null =>
	event.actor.name === null ? null : (event.actor.email ?? event.actor.id)

/** What was acted on: its name or id, null when the event names nothing. */
export const targetText = (event: AuditTrailEntry): string | null => event.target.name ?? event.target.id

/** Anything but a success gets a mark in the list: an unknown outcome must not read as one. */
export const isMarked = (event: AuditTrailEntry): boolean => event.outcome !== "success"

export const isFiltered = (search: Search): boolean =>
	search.provider !== undefined ||
	search.category !== undefined ||
	search.outcome !== undefined ||
	search.actor !== undefined

/** The API refused the viewer: the same thing the session says for a member without the permission. */
export const isForbidden = (failure: LoadFailure): boolean => failure.code === "audit_trail_forbidden"

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

/** The cursor after everything loaded so far, or null at the end of the list. */
export const nextCursorOf = (model: Pick<Model, "firstPage" | "laterPages">): string | null =>
	Option.match(Arr.last(model.laterPages.pages), {
		onNone: () =>
			AsyncData.matchData(model.firstPage.data, {
				onEmpty: () => null,
				onFailure: () => null,
				onData: (page) => page.nextCursor,
			}),
		onSome: (page) => page.nextCursor,
	})
