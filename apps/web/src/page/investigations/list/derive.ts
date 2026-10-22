import type { V2Investigation } from "@maple/domain/http/v2"
import { toEpochMs } from "@maple/ui/lib/time-format"
import {
	investigationKindKey,
	matchesQuery,
	sortInvestigations,
	type InvestigationKindKey,
} from "@maple/web-data/investigations/display"
import { AsyncData } from "foldkit"
import type { InvestigationsSearch } from "../../../route/search"
import type { InvestigationPage, Model } from "./model"

export type Search = typeof InvestigationsSearch.Type
export type HubView = "active" | "history"

export const viewOf = (search: Search): HubView => search.view ?? "active"

const ACTIVE: ReadonlyArray<V2Investigation["status"]> = ["investigating", "diagnosed"]
export const isActive = (investigation: V2Investigation) => ACTIVE.includes(investigation.status)

const pageOf = (slot: Model["firstPage"]): InvestigationPage | null =>
	AsyncData.getOrElse(slot.data, () => null)

/** The first page and every "Load more" page, deduped by id. */
export const allOf = (model: Model): ReadonlyArray<V2Investigation> => {
	const byId = new Map<string, V2Investigation>()
	;[model.firstPage, ...model.morePages.map((more) => more.page)].forEach((slot) =>
		(pageOf(slot)?.data ?? []).forEach((investigation) => {
			if (!byId.has(investigation.id)) byId.set(investigation.id, investigation)
		}),
	)
	return [...byId.values()]
}

/** The last page's cursor, while it says there is more. */
export const nextCursorOf = (model: Model): string | null => {
	const last = model.morePages[model.morePages.length - 1]?.page ?? model.firstPage
	const page = pageOf(last)
	return page !== null && page.hasMore ? page.nextCursor : null
}

export const isLoadingMoreOf = (model: Model): boolean => {
	const last = model.morePages[model.morePages.length - 1]
	return last !== undefined && (AsyncData.isLoading(last.page.data) || AsyncData.isIdle(last.page.data))
}

export const visibleOf = (model: Model, all: ReadonlyArray<V2Investigation>) => {
	const { search } = model
	const view = viewOf(search)
	const query = search.q ?? ""
	const inView = all.filter((investigation) =>
		view === "active" ? isActive(investigation) : !isActive(investigation),
	)
	const filtered = inView.filter(
		(investigation) =>
			(search.kind === undefined || investigationKindKey(investigation.subject) === search.kind) &&
			matchesQuery(investigation, query),
	)
	return sortInvestigations(filtered, search.sort ?? "updated", search.dir ?? "desc")
}

const DAY_MS = 24 * 60 * 60 * 1000

/** `TriageStrip`'s three numbers, from the fetched page. */
export const triageStatsOf = (all: ReadonlyArray<V2Investigation>, nowMs: number) => {
	const running = all.filter((entry) => entry.status === "investigating")
	const review = all.filter((entry) => entry.status === "diagnosed")
	const cutoff = nowMs - DAY_MS
	const resolved = all.filter(
		(entry) => entry.status === "resolved" && toEpochMs(entry.updated_at) >= cutoff,
	)
	const critical = review.filter(
		(entry) => (entry.severity ?? entry.snapshot.severity) === "critical",
	).length
	return { running: running.length, review: review.length, resolved: resolved.length, critical }
}

export const KIND_FILTER_LABEL = {
	all: "All kinds",
	alert: "Alerts",
	error: "Errors",
	anomaly: "Anomalies",
	question: "Questions",
	verification: "Fix checks",
} as const satisfies Record<InvestigationKindKey | "all", string>

export const KIND_FILTER_VALUES: ReadonlyArray<InvestigationKindKey | "all"> = [
	"all",
	"alert",
	"error",
	"anomaly",
	"question",
	"verification",
]

export const SORT_OPTIONS = [
	{ value: "updated:desc", label: "Newest first" },
	{ value: "updated:asc", label: "Oldest first" },
	{ value: "severity:desc", label: "Most severe" },
	{ value: "confidence:desc", label: "Most confident" },
] as const

export const sortValueOf = (search: Search): string => `${search.sort ?? "updated"}:${search.dir ?? "desc"}`
