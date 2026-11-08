// The combined landing pages table: Search Console page clicks joined with Maple's own sessions
// entering on the same page. The two halves can live on different warehouses (Search Console is
// pinned to the managed route, web analytics follows the org's), so they are merged here.
import type { SearchConsoleLandingPage } from "@maple/domain/http"
import { Array as Arr, Option, Order, String as Str } from "effect"

/** One page-grain row as the landing pages query returns it. */
export interface SearchPageRow {
	readonly page: string
	readonly clicks: number
	readonly impressions: number
	readonly positionSum: number
}

/** One entry-page row of the browser SDK's sessions. */
export interface EntryPageRow {
	readonly host: string
	readonly entryPath: string
	readonly sessions: number
	readonly bouncedSessions: number
	readonly identifiedSessions: number
}

export interface LandingKey {
	readonly host: string
	readonly path: string
}

/** Lowercased, without a trailing dot. `www.` is kept: web analytics records it as visited. */
export const normalizeHost = (host: string): string => Str.replace(/\.$/, "")(Str.toLowerCase(host))

/** The pathname without query string or fragment, and without a trailing slash except at the root. */
export const normalizePath = (path: string): string => {
	const bare = Str.replace(/[?#].*$/s, "")(path)
	const trimmed = Str.replace(/\/+$/, "")(bare)
	return trimmed === "" ? "/" : Str.startsWith("/")(trimmed) ? trimmed : `/${trimmed}`
}

const URL_PATTERN = /^https?:\/\/([^/?#]+)([^?#]*)/i

/** The host and path of a full page URL, as Google reports it; none for anything else. */
export const landingKeyOfUrl = (url: string): Option.Option<LandingKey> =>
	Option.map(Option.fromNullishOr(URL_PATTERN.exec(url)), (match) => ({
		host: normalizeHost(match[1] ?? ""),
		path: normalizePath(match[2] ?? ""),
	}))

const keyString = (key: LandingKey): string => `${key.host}\n${key.path}`

/** The `EntryPath` values worth asking web analytics about: each path with and without its slash. */
export const entryPathsFor = (pages: ReadonlyArray<SearchPageRow>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.flatMap(pages, (row) =>
			Option.match(landingKeyOfUrl(row.page), {
				onNone: () => [],
				onSome: ({ path }) => (path === "/" ? [path] : [path, `${path}/`]),
			}),
		),
	)

interface EntryTotals {
	readonly sessions: number
	readonly bouncedSessions: number
	readonly identifiedSessions: number
}

const entryTotals = (rows: ReadonlyArray<EntryPageRow>): ReadonlyMap<string, EntryTotals> =>
	Arr.reduce(rows, new Map<string, EntryTotals>(), (totals, row) => {
		const key = keyString({ host: normalizeHost(row.host), path: normalizePath(row.entryPath) })
		const current = totals.get(key) ?? { sessions: 0, bouncedSessions: 0, identifiedSessions: 0 }
		return totals.set(key, {
			sessions: current.sessions + row.sessions,
			bouncedSessions: current.bouncedSessions + row.bouncedSessions,
			identifiedSessions: current.identifiedSessions + row.identifiedSessions,
		})
	})

interface SearchTotals extends LandingKey {
	readonly page: string
	readonly topClicks: number
	readonly clicks: number
	readonly impressions: number
	readonly positionSum: number
}

const byClicks = Order.mapInput(Order.flip(Order.Number), (row: SearchConsoleLandingPage) => row.clicks)

/**
 * Search pages grouped by normalised host + path (http and https, or `/a` and `/a/`, are one
 * landing page), each with the sessions that entered there. `conversions` is the same entry read
 * narrowed to sessions that fired the conversion event, or null when none was asked for.
 */
export const mergeLandingPages = (input: {
	readonly pages: ReadonlyArray<SearchPageRow>
	readonly entries: ReadonlyArray<EntryPageRow>
	readonly conversions: ReadonlyArray<EntryPageRow> | null
}): ReadonlyArray<SearchConsoleLandingPage> => {
	const search = Arr.reduce(input.pages, new Map<string, SearchTotals>(), (totals, row) =>
		Option.match(landingKeyOfUrl(row.page), {
			onNone: () => totals,
			onSome: (key) => {
				const current = totals.get(keyString(key))
				const isTop = current === undefined || row.clicks > current.topClicks
				return totals.set(keyString(key), {
					...key,
					page: isTop || current === undefined ? row.page : current.page,
					topClicks: isTop || current === undefined ? row.clicks : current.topClicks,
					clicks: (current?.clicks ?? 0) + row.clicks,
					impressions: (current?.impressions ?? 0) + row.impressions,
					positionSum: (current?.positionSum ?? 0) + row.positionSum,
				})
			},
		}),
	)
	const entries = entryTotals(input.entries)
	const conversions = input.conversions === null ? null : entryTotals(input.conversions)
	const rows = Arr.map([...search.entries()], ([key, row]): SearchConsoleLandingPage => {
		const entry = entries.get(key)
		return {
			page: row.page,
			host: row.host,
			path: row.path,
			clicks: row.clicks,
			impressions: row.impressions,
			ctr: row.impressions > 0 ? row.clicks / row.impressions : 0,
			position: row.impressions > 0 ? row.positionSum / row.impressions : 0,
			sessions: entry?.sessions ?? 0,
			bounceRate:
				entry !== undefined && entry.identifiedSessions > 0
					? entry.bouncedSessions / entry.identifiedSessions
					: null,
			conversions: conversions === null ? null : (conversions.get(key)?.sessions ?? 0),
		}
	})
	return Arr.sort(rows, byClicks)
}
