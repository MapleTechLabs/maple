import { type StatusPageComponentId, StatusPageId, type StatusPageIncidentId } from "@maple/domain"
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
import { Effect, Option, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"
import { listMonitors } from "../../alerts/shared/uptime-commands"
import { summarizePage } from "./derive"

// The status page reads and writes, as Effects the pages' Commands wrap, and their links.

/** One page of each list: far past any plan's allowance of pages, components or open incidents. */
const LIST_LIMIT = 100
/** Recent incidents the editor lists: the open ones plus the latest closed. */
const INCIDENT_LIMIT = 50

const listPages = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return (yield* client.statusPages.list({ query: { limit: LIST_LIMIT } })).data
})

const listPageComponents = (id: StatusPageId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return (yield* client.statusPages.listComponents({ params: { id }, query: { limit: LIST_LIMIT } }))
			.data
	})

const listOpenIncidents = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return (yield* client.statusPageIncidents.list({ query: { state: "open", limit: LIST_LIMIT } })).data
})

/** The list's rows: each page with its components' worst status and its open incident count. */
export const listPageSummaries = Effect.gen(function* () {
	const pages = yield* listPages
	if (pages.length === 0) return []
	const [incidents, monitors, components] = yield* Effect.all(
		[
			listOpenIncidents,
			// A failed monitor read fails the tab: without it every monitored component would read green.
			listMonitors,
			Effect.forEach(pages, (page) => listPageComponents(page.id), { concurrency: 4 }),
		],
		{ concurrency: "unbounded" },
	)
	return pages.map((page, index) =>
		summarizePage({
			page,
			components: components[index] ?? [],
			incidents: incidents.filter((incident) => incident.page_id === page.id),
			monitors,
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

export const postIncidentUpdate = (id: StatusPageIncidentId, payload: V2StatusPageIncidentPostUpdateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.statusPageIncidents.postUpdate({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

// LINKS

const encodePublicId = Schema.encodeSync(StatusPagePublicId)
const decodePublicId = Schema.decodeUnknownOption(StatusPagePublicId)
const decodeInternalId = Schema.decodeUnknownOption(StatusPageId)

/** The `stp_…` id in a URL, or a raw UUID, as the internal id. */
export const pageIdFromUrl = (raw: string): Option.Option<StatusPageId> =>
	Option.orElse(decodePublicId(raw), () => decodeInternalId(raw))

/** The editor's views: the page itself (none), its settings, its JSON, or the just-published screen. */
export type EditorView = "settings" | "json" | "live"

export const statusPageHref = (id: StatusPageId, view?: EditorView): string =>
	hrefOf(
		AppRoute.StatusPage({
			pageId: encodePublicId(id),
			search: view === undefined ? {} : { view },
		}),
	)

export const statusPagesHref = (): string => hrefOf(AppRoute.StatusPages())

export const newStatusPageHref = (): string => hrefOf(AppRoute.StatusPageNew())

/** The status Worker's origin; empty where it has no domain yet (prd today). */
export const STATUS_PAGE_BASE_URL: string = (import.meta.env.VITE_STATUS_PAGE_BASE_URL ?? "")
	.trim()
	.replace(/\/+$/u, "")

/** Where visitors read the page, or `null` while no status domain is configured. */
export const publicUrl = (baseUrl: string, slug: string): string | null =>
	baseUrl === "" ? null : `${baseUrl}/s/${slug}`

/** The page's address as text: the full URL when known, its `/s/<slug>` path otherwise. */
export const publicAddress = (slug: string): string => publicUrl(STATUS_PAGE_BASE_URL, slug) ?? `/s/${slug}`
