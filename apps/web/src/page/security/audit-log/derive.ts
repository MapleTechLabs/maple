import { AuditTrailCategory, AuditTrailOutcome, AuditTrailProvider } from "@maple/domain/audit-trail"
import type { AuditTrailEntry } from "@maple/domain/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option, Schema } from "effect"
import { AsyncData } from "foldkit"
import { labelIn } from "../kit/audit-labels"
import { detectionFormHref } from "../kit/detection-format"
import type { Model, Search } from "./model"

// What the audit log shows of an event: who acted and on what. The names of platforms, categories
// and outcomes are in `../kit/audit-labels`.

const ACTOR_TYPE_LABEL = {
	user: "User",
	service: "Service",
	system: "System",
	unknown: "Unknown actor",
} as const

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

const isProvider = Schema.is(AuditTrailProvider)
const isCategory = Schema.is(AuditTrailCategory)
const isOutcome = Schema.is(AuditTrailOutcome)

/**
 * The detection editor prefilled with the filters a detection can hold: the platform, category
 * and outcome. Never the actor: a detection cannot name a person. Null when none of them is set.
 */
export const alertHref = (search: Search): string | null => {
	const provider = isProvider(search.provider) ? search.provider : undefined
	const category = isCategory(search.category) ? search.category : undefined
	const outcome = isOutcome(search.outcome) ? search.outcome : undefined
	return provider === undefined && category === undefined && outcome === undefined
		? null
		: detectionFormHref({ provider, category, outcome })
}

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
