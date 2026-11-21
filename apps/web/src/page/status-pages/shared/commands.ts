import {
	type StatusPageComponentId,
	StatusPageId,
	type StatusPageIncidentId,
	type StatusPageVisibility,
} from "@maple/domain"
import {
	type StatusPageConfig,
	type StatusPagePreviewParams,
	StatusPagePublicId,
	type V2StatusPageComponentCreateParams,
	type V2StatusPageCreateParams,
	type V2StatusPageIncidentCreateParams,
	type V2StatusPageIncidentPostUpdateParams,
	type V2StatusPageIncidentUpdateParams,
	type V2StatusPageUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Option, Schema, Array as Arr, String as Str } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { readAllPages as readAll } from "../../../platform/read-all-pages"
import { AppRoute, hrefOf } from "../../../route"
import type { StatusPageSetupMethod } from "../../../route/search"
import { summarizePage } from "./derive"

// The status page reads and writes, as Effects the pages' Commands wrap, and their links.

const LIST_LIMIT = 100
/** Recent incidents the editor lists: the open ones plus the latest closed. */
const INCIDENT_LIMIT = 50

const listPages = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* readAll((cursor) => client.statusPages.list({ query: { limit: LIST_LIMIT, cursor } }))
})

const listPageComponents = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* readAll((cursor) =>
			client.statusPages.listComponents({ params: { id }, query: { limit: LIST_LIMIT, cursor } }),
		)
	})

const viewSnapshot = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.view({ params: { id } })
	})

const listOpenIncidents = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* readAll((cursor) =>
		client.statusPageIncidents.list({ query: { state: "open", limit: LIST_LIMIT, cursor } }),
	)
})

/**
 * The list's cards: each page as visitors see it now (statuses and uptime bars, from its live
 * view) with its open incidents and maintenance, drafts included, and each component's monitor.
 */
export const listPageSummaries = Effect.gen(function* () {
	const pages = yield* listPages
	if (pages.length === 0) return []
	const [incidents, perPage] = yield* Effect.all(
		[
			listOpenIncidents,
			Effect.forEach(
				pages,
				(page) =>
					Effect.all([viewSnapshot(page.id), listPageComponents(page.id)], { concurrency: 2 }),
				{ concurrency: 4 },
			),
		],
		{ concurrency: "unbounded" },
	)
	return Arr.zipWith(pages, perPage, (page, [snapshot, components]) =>
		summarizePage({
			page,
			snapshot,
			components,
			incidents: Arr.filter(incidents, (incident) => incident.page_id === page.id),
		}),
	)
}).pipe(Effect.mapError(toLoadFailure))

export const retrievePage = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.retrieve({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const listComponents = (id: StatusPageId) =>
	listPageComponents(id).pipe(Effect.mapError(toLoadFailure))

/** The page's incidents and maintenance, open and closed, newest first. */
export const listPageIncidents = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.statusPageIncidents.list({
			query: { page_id: id, state: "all", limit: INCIDENT_LIMIT },
		})
		return response.data
	}).pipe(Effect.mapError(toLoadFailure))

/** The snapshot a draft would publish, with its monitors' real history; writes nothing. */
export const previewPage = (payload: StatusPagePreviewParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.preview({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

/** Creates the page with its components in one write; `publish` makes it public at once. */
export const createPage = (payload: V2StatusPageCreateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.create({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const updatePage = (id: StatusPageId, payload: V2StatusPageUpdateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.update({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const deletePage = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.statusPages.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const publishPage = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.publish({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const rotateBreakGlass = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.rotateBreakGlass({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const setPagePassword = (id: StatusPageId, password: string) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.setPassword({ params: { id }, payload: { password } })
	}).pipe(Effect.mapError(toLoadFailure))

export const removePagePassword = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.removePassword({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** The page as visitors would see it now, whatever its visibility: how members read an internal page. */
export const viewPage = (id: StatusPageId) => viewSnapshot(id).pipe(Effect.mapError(toLoadFailure))

export const retrieveCustomDomain = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.getCustomDomain({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const setCustomDomain = (id: StatusPageId, hostname: string) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.setCustomDomain({ params: { id }, payload: { hostname } })
	}).pipe(Effect.mapError(toLoadFailure))

export const checkCustomDomain = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.checkCustomDomain({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const removeCustomDomain = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.removeCustomDomain({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const revokeBreakGlass = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.revokeBreakGlass({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Adds a component, or updates `componentId`. */
export const saveComponent = (
	id: StatusPageId,
	componentId: StatusPageComponentId | null,
	payload: V2StatusPageComponentCreateParams,
) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return componentId === null
			? yield* client.statusPages.createComponent({ params: { id }, payload })
			: yield* client.statusPages.updateComponent({
					params: { id, component_id: componentId },
					payload,
				})
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteComponent = (id: StatusPageId, componentId: StatusPageComponentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.statusPages.deleteComponent({ params: { id, component_id: componentId } })
	}).pipe(Effect.mapError(toLoadFailure))

export const reorderComponents = (id: StatusPageId, componentIds: ReadonlyArray<StatusPageComponentId>) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const response = yield* client.statusPages.reorderComponents({
			params: { id },
			payload: { component_ids: componentIds },
		})
		return response.data
	}).pipe(Effect.mapError(toLoadFailure))

/** The page as one document, with the revision it was read at. */
export const retrievePageConfig = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.getConfig({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/**
 * Replaces the page with `config` in one write and returns the applied document. A page past
 * `ifVersion` refuses it if the config changed since, so a stale document never deletes what
 * someone else added.
 */
export const applyPageConfig = (id: StatusPageId, config: StatusPageConfig, ifVersion: string | undefined) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPages.applyConfig({
			params: { id },
			query: { if_version: ifVersion },
			payload: config,
		})
	}).pipe(Effect.mapError(toLoadFailure))

export const createIncident = (payload: V2StatusPageIncidentCreateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPageIncidents.create({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const updateIncident = (id: StatusPageIncidentId, payload: V2StatusPageIncidentUpdateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPageIncidents.update({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteIncident = (id: StatusPageIncidentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.statusPageIncidents.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const postIncidentUpdate = (id: StatusPageIncidentId, payload: V2StatusPageIncidentPostUpdateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPageIncidents.postUpdate({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

const encodePublicId = Schema.encodeSync(StatusPagePublicId)
const decodePublicId = Schema.decodeUnknownOption(StatusPagePublicId)
const decodeInternalId = Schema.decodeUnknownOption(StatusPageId)

/** The `stp_…` id in a URL, or a raw UUID, as the internal id. */
export const pageIdFromUrl = (raw: string): Option.Option<StatusPageId> =>
	Option.orElse(decodePublicId(raw), () => decodeInternalId(raw))

/** The editor's tabs after the live page (none), and the screen right after publishing. */
export type EditorView = "incidents" | "maintenance" | "settings" | "live"

/** The Settings tab's sections, in menu order. */
export const SETTINGS_SECTIONS = ["basic", "monitors", "appearance", "advanced"] as const
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]

export const statusPageHref = (id: StatusPageId, view?: EditorView, section?: SettingsSection): string =>
	hrefOf(
		AppRoute.StatusPage({
			pageId: encodePublicId(id),
			search: { view, section },
		}),
	)

/** The dev preview: the page as members read it inside Maple, whatever its visibility; an internal page's only address. */
export const statusPageViewHref = (id: StatusPageId): string =>
	hrefOf(AppRoute.StatusPageView({ pageId: encodePublicId(id) }))

export const statusPagesHref = (): string => hrefOf(AppRoute.StatusPages())

export const newStatusPageHref = (setup?: StatusPageSetupMethod): string =>
	hrefOf(AppRoute.StatusPageNew({ search: setup === undefined ? {} : { setup } }))

/** The status Worker's origin; empty where the stage has no status domain. */
export const STATUS_PAGE_BASE_URL: string = Str.replace(
	/\/+$/u,
	"",
)(Str.trim(import.meta.env.VITE_STATUS_PAGE_BASE_URL ?? ""))

/** The page's path on the status domain: `/s/<org key>/<slug>`, slugs being unique per org. */
export const publicPath = (orgKey: string, slug: string): string => `/s/${orgKey}/${slug}`

/** Where visitors read the page, or `null` while no status domain is configured. */
export const publicUrl = (baseUrl: string, orgKey: string, slug: string): string | null =>
	baseUrl === "" ? null : `${baseUrl}${publicPath(orgKey, slug)}`

/** The page's canonical address: its active custom domain, else {@link publicUrl}. */
export const canonicalUrl = (
	baseUrl: string,
	orgKey: string,
	slug: string,
	customDomain: string | null,
): string | null => (customDomain === null ? publicUrl(baseUrl, orgKey, slug) : `https://${customDomain}`)

/** The page's address as text: the full URL when known, its path otherwise. */
export const publicAddress = (orgKey: string, slug: string): string =>
	publicUrl(STATUS_PAGE_BASE_URL, orgKey, slug) ?? publicPath(orgKey, slug)

/** The public page to open, or why there is none: it is internal, a draft, or the stage has no status domain. */
export type PublicPageLink =
	| Readonly<{ _tag: "Open"; url: string }>
	| Readonly<{ _tag: "Unavailable"; reason: string }>

/** `url` is where visitors read the page ({@link publicUrl} or {@link canonicalUrl}), null without a status domain. */
export const publicPageLink = (
	page: Readonly<{ visibility: StatusPageVisibility; draft: boolean }>,
	url: string | null,
): PublicPageLink => {
	if (page.visibility === "internal")
		return {
			_tag: "Unavailable",
			reason: "Internal pages are not served publicly. Members read them in the dev preview.",
		}
	if (url === null) return { _tag: "Unavailable", reason: "No status domain is configured" }
	if (page.draft) return { _tag: "Unavailable", reason: "Publish the page to open it" }
	return { _tag: "Open", url }
}
