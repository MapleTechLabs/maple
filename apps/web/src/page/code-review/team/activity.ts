import type { CodeReviewTeamActivity } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"

// The activity calendar's days: every day of the window in the viewer's zone, and per day the
// people and repositories behind it.

export type ActivityCount = Readonly<{ key: string; opened: number; merged: number }>

export type ActivityDay = Readonly<{
	day: string
	opened: number
	merged: number
	/** Busiest first. */
	people: ReadonlyArray<ActivityCount>
	repositories: ReadonlyArray<ActivityCount>
}>

export const totalOf = (count: { readonly opened: number; readonly merged: number }) =>
	count.opened + count.merged

/** `YYYY-MM-DD` of an epoch ms in a zone, as the server buckets it. */
export const dayIn = (timeZone: string) => {
	const format = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	})
	return (ms: number) => format.format(ms)
}

const utcOf = (day: string) => {
	const [year, month = 1, date = 1] = Arr.map(Str.split("-")(day), Number)
	return Date.UTC(year, month - 1, date)
}

/** Every calendar day the window touches, first to last. */
export const daysOf = (startTime: number, endTime: number, timeZone: string): ReadonlyArray<string> => {
	if (endTime <= startTime) return []
	const dayOf = dayIn(timeZone)
	const first = utcOf(dayOf(startTime))
	const count = Math.round((utcOf(dayOf(endTime - 1)) - first) / 86_400_000) + 1
	return Array.from({ length: count }, (_, index) =>
		Str.slice(0, 10)(new Date(first + index * 86_400_000).toISOString()),
	)
}

const tally = (
	counts: Map<string, { opened: number; merged: number }>,
	key: string,
	row: CodeReviewTeamActivity,
) => {
	const found = counts.get(key) ?? { opened: 0, merged: 0 }
	counts.set(key, { opened: found.opened + row.opened, merged: found.merged + row.merged })
}

const busiestFirst = (
	counts: Map<string, { opened: number; merged: number }>,
): ReadonlyArray<ActivityCount> =>
	Arr.map([...counts.entries()], ([key, count]) => ({ key, ...count })).toSorted(
		(a, b) => totalOf(b) - totalOf(a) || a.key.localeCompare(b.key, "en", { sensitivity: "base" }),
	)

/** The activity rows folded by day; days without a pull request are absent. */
export const activityByDay = (
	activity: ReadonlyArray<CodeReviewTeamActivity>,
): ReadonlyMap<string, ActivityDay> => {
	const grouped = new Map<string, Array<CodeReviewTeamActivity>>()
	for (const row of activity) grouped.set(row.day, [...(grouped.get(row.day) ?? []), row])
	return new Map(
		Arr.map([...grouped.entries()], ([day, rows]) => {
			const people = new Map<string, { opened: number; merged: number }>()
			const repositories = new Map<string, { opened: number; merged: number }>()
			for (const row of rows) {
				tally(people, row.login, row)
				tally(repositories, row.repository, row)
			}
			return [
				day,
				{
					day,
					opened: Arr.reduce(rows, 0, (sum, row) => sum + row.opened),
					merged: Arr.reduce(rows, 0, (sum, row) => sum + row.merged),
					people: busiestFirst(people),
					repositories: busiestFirst(repositories),
				},
			]
		}),
	)
}
