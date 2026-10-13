import { getCollection, type CollectionEntry } from "astro:content"

export type Release = CollectionEntry<"changelog">

/** Entries per timeline page. */
export const PAGE_SIZE = 8

/** Entries newest first. Drafts are excluded in production builds. */
export async function getSortedReleases(): Promise<Release[]> {
	const releases = await getCollection("changelog", ({ data }) => !data.draft || import.meta.env.DEV)
	// Same-day entries fall back to the id so the order is stable across builds.
	return releases.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || b.id.localeCompare(a.id))
}

export function pageCount(total: number): number {
	return Math.max(1, Math.ceil(total / PAGE_SIZE))
}

/** Page 1 is the bare index; later pages live under /changelog/page/N. */
export function pageHref(page: number): string {
	return page <= 1 ? "/changelog" : `/changelog/page/${page}`
}

export function monthKey(date: Date): string {
	return `${date.getUTCFullYear()}-${date.getUTCMonth()}`
}

const DAY_FMT = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
const MONTH_FMT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", timeZone: "UTC" })

/** "Sep 23": the timeline gutter, where the month divider carries the year. */
export function dayLabel(date: Date): string {
	return DAY_FMT.format(date)
}

/** "September 2026" */
export function monthName(date: Date): string {
	return MONTH_FMT.format(date)
}
