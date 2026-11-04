import type { FilterOption } from "@maple/views/ui/filters/filter-section"
import { Array as Arr, Record } from "effect"
import type { UserDetail, UserRow } from "../page/users/data"
import type { UsersFacets, UsersFilters } from "../page/users/view-list"

// `/lab/users`' stand-in for the warehouse: the facet counts, the directory filter and a user's
// namespace scope, applied to the fixture the way the queries will apply them.

const facet = (values: ReadonlyArray<string>): ReadonlyArray<FilterOption> =>
	Arr.map(Object.entries(Arr.groupBy(values, (value) => value)), ([name, hits]) => ({
		name,
		count: hits.length,
	})).toSorted((a, b) => b.count - a.count)

/** Users per namespace and per group, and how many hit an error or have a replay. */
export const usersFacets = (rows: ReadonlyArray<UserRow>): UsersFacets => ({
	namespaces: facet(Arr.flatMap(rows, (row) => row.namespaces)),
	groups: facet(
		Arr.filter(
			Arr.map(rows, (row) => row.groupId),
			(group): group is string => group !== null,
		),
	),
	withErrors: Arr.filter(rows, (row) => row.errors > 0).length,
	withReplay: Arr.filter(rows, (row) => row.signals.includes("replay")).length,
})

/** The namespaces in effect: the org pin wins over the rail's picks. */
export const scopeOf = (filters: UsersFilters, pinned: string | null): ReadonlyArray<string> =>
	pinned === null ? filters.namespaces : [pinned]

/** The directory's rows: search on id, name or email, the toggles, then namespace and group. */
export const filterUsers = (
	rows: ReadonlyArray<UserRow>,
	filters: UsersFilters,
	pinned: string | null,
): ReadonlyArray<UserRow> => {
	const needle = filters.search.trim().toLowerCase()
	const scope = scopeOf(filters, pinned)
	return Arr.filter(
		rows,
		(row) =>
			(needle === "" ||
				Arr.some([row.userId, row.name, row.email], (field) =>
					(field ?? "").toLowerCase().includes(needle),
				)) &&
			(!filters.hasErrors || row.errors > 0) &&
			(!filters.hasReplay || row.signals.includes("replay")) &&
			(scope.length === 0 || Arr.some(row.namespaces, (namespace) => scope.includes(namespace))) &&
			(filters.groups.length === 0 || (row.groupId !== null && filters.groups.includes(row.groupId))),
	)
}

/** One user narrowed to a namespace: every row whose service lives in another one drops out. */
export const scopeDetail = (detail: UserDetail, namespace: string | null): UserDetail => {
	if (namespace === null) return detail
	const namespaceOf = Record.fromEntries(
		Arr.map(detail.profile.services, (service) => [service.service, service.namespace] as const),
	)
	const keep = <A extends { readonly service: string }>(items: ReadonlyArray<A>): ReadonlyArray<A> =>
		Arr.filter(items, (item) => namespaceOf[item.service] === namespace)
	const sessions = keep(detail.sessions)
	const issues = keep(detail.issues)
	const traces = keep(detail.traces)
	const logs = keep(detail.logs)
	const events = keep(detail.events)
	const spans = Arr.reduce(detail.profile.services, { all: 0, kept: 0 }, (sum, service) => ({
		all: sum.all + service.spans,
		kept: sum.kept + (service.namespace === namespace ? service.spans : 0),
	}))
	// The fixture has no per-namespace request counts; the namespace's share of spans stands in.
	const share = spans.all === 0 ? 0 : spans.kept / spans.all
	return {
		...detail,
		profile: {
			...detail.profile,
			sessions: sessions.length,
			recordedMs: sessions.length === 0 ? 0 : detail.profile.recordedMs,
			requests: Math.round(detail.profile.requests * share),
			activity: Arr.map(detail.profile.activity, (value) => Math.round(value * share)),
			errors: Arr.reduce(issues, 0, (sum, issue) => sum + issue.hits),
			issues: issues.length,
			traces: traces.length,
			logs: logs.length,
			events: events.length,
			distinctEvents: new Set(Arr.map(events, (event) => event.name)).size,
		},
		activity: keep(detail.activity),
		sessions,
		issues,
		traces,
		logs,
		events,
	}
}
