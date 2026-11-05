import type { FilterOption } from "@maple/views/ui/filters/filter-section"
import { Array as Arr, Option, Order, Record, String as Str } from "effect"
import type { UserDetail, UserRow } from "../page/users/data"
import type { UsersFacets, UsersFilters, UsersSummary } from "../page/users/view-list"

// `/lab/users`' stand-in for the warehouse: the facet counts, the directory filter and a user's
// namespace scope, applied to the fixture the way the queries will apply them.

const facet = (values: ReadonlyArray<string>): ReadonlyArray<FilterOption> =>
	Arr.sort(
		Arr.map(Record.toEntries(Arr.groupBy(values, (value) => value)), ([name, hits]) => ({
			name,
			count: hits.length,
		})),
		Order.flip(Order.mapInput(Order.Number, (option: FilterOption) => option.count)),
	)

/**
 * Users per namespace and per group, and how many hit an error or have a replay. Under a pin the
 * counts cover the pinned namespace's users and there is no namespace facet, as the API reads it.
 */
export const usersFacets = (all: ReadonlyArray<UserRow>, pinned: string | null): UsersFacets => {
	const rows = pinned === null ? all : Arr.filter(all, (row) => row.namespaces.includes(pinned))
	return {
		namespaces: pinned === null ? facet(Arr.flatMap(rows, (row) => row.namespaces)) : [],
		groups: Arr.map(
			facet(
				Arr.filter(
					Arr.map(rows, (row) => row.groupId),
					(group): group is string => group !== null,
				),
			),
			(option) => ({
				...option,
				label: Arr.findFirst(
					rows,
					(row) => row.groupId === option.name && row.groupName !== null,
				).pipe(Option.match({ onNone: () => null, onSome: (row) => row.groupName })),
			}),
		),
		withErrors: Arr.filter(rows, (row) => row.errors > 0).length,
		withReplay: Arr.filter(rows, (row) => row.signals.includes("replay")).length,
	}
}

const DAY_MS = 86_400_000

/**
 * The summary strip over the pin, as the API reads it: the fixture's org-wide totals unpinned,
 * else the pinned namespace's sample users (anonymous visitors scaled to their share).
 */
export const usersSummary = (
	all: ReadonlyArray<UserRow>,
	pinned: string | null,
	orgWide: UsersSummary,
	nowMs: number,
): UsersSummary => {
	if (pinned === null) return orgWide
	const rows = Arr.filter(all, (row) => row.namespaces.includes(pinned))
	return {
		identified: rows.length,
		activeToday: Arr.filter(rows, (row) => row.lastSeenMs >= nowMs - DAY_MS).length,
		withErrors: Arr.filter(rows, (row) => row.errors > 0).length,
		anonymousVisitors:
			all.length === 0 ? 0 : Math.round((orgWide.anonymousVisitors * rows.length) / all.length),
	}
}

/** The namespaces in effect: the org pin wins over the rail's picks. */
export const scopeOf = (filters: UsersFilters, pinned: string | null): ReadonlyArray<string> =>
	pinned === null ? filters.namespaces : [pinned]

/** The directory's rows: search on id, name or email, the toggles, then namespace and group. */
export const filterUsers = (
	rows: ReadonlyArray<UserRow>,
	filters: UsersFilters,
	pinned: string | null,
): ReadonlyArray<UserRow> => {
	const needle = Str.toLowerCase(Str.trim(filters.search))
	const scope = scopeOf(filters, pinned)
	return Arr.filter(
		rows,
		(row) =>
			(needle === "" ||
				Arr.some([row.userId, row.name, row.email], (field) =>
					Str.includes(needle)(Str.toLowerCase(field ?? "")),
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
	const mcpSessions = Arr.filter(
		detail.mcpSessions,
		(session) => namespaceOf[session.service] === namespace,
	)
	const signals = Arr.reduce(detail.profile.services, { all: 0, kept: 0 }, (sum, service) => ({
		all: sum.all + service.signals,
		kept: sum.kept + (service.namespace === namespace ? service.signals : 0),
	}))
	// The fixture has no per-namespace request counts; the namespace's share of signals stands in.
	const share = signals.all === 0 ? 0 : signals.kept / signals.all
	return {
		...detail,
		profile: {
			...detail.profile,
			sessions: sessions.length,
			recordedMs: sessions.length === 0 ? 0 : detail.profile.recordedMs,
			requests: detail.profile.requests === null ? null : Math.round(detail.profile.requests * share),
			activity: Arr.map(detail.profile.activity, (value) => Math.round(value * share)),
			issueHits: Arr.reduce(issues, 0, (sum, issue) => sum + issue.hits),
			issues: issues.length,
			traces: traces.length,
			logs: logs.length,
			events: events.length,
			distinctEvents: new Set(Arr.map(events, (event) => event.name)).size,
			mcpCalls: Arr.reduce(mcpSessions, 0, (sum, session) => sum + session.calls),
		},
		activity: keep(detail.activity),
		sessions,
		issues,
		traces,
		logs,
		events,
		mcpSessions,
	}
}
