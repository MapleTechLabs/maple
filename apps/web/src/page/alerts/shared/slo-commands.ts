import { SloId } from "@maple/domain"
import {
	SloPublicId,
	type V2Slo,
	V2SloAlertingParams,
	V2SloCreateParams,
	type V2SloStatus,
	V2SloUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Option, Ref, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"
import type { AlertsSloNewSearch } from "../../../route/search"

// The SLO reads and writes, as Effects the pages' Commands wrap, and their links.

export const SLO_LIST_LIMIT = 100

/** Pages read at most per list: 2000 SLOs. */
const MAX_LIST_PAGES = 20

/** How many status reads the SLOs tab runs at once. */
const STATUS_CONCURRENCY = 6

interface ListProgress {
	readonly rows: ReadonlyArray<V2Slo>
	readonly cursor: string | null
	readonly pages: number
}

/** `slos.list`: every one of the org's SLOs, newest first, following `next_cursor`. */
export const listSlos = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const progress = yield* Ref.make<ListProgress>({ rows: [], cursor: null, pages: 0 })
	const readPage = Effect.gen(function* () {
		const { rows, cursor, pages } = yield* Ref.get(progress)
		const response = yield* client.slos.list({
			query: { limit: SLO_LIST_LIMIT, ...(cursor === null ? undefined : { cursor }) },
		})
		const next = response.has_more ? response.next_cursor : null
		yield* Ref.set(progress, { rows: [...rows, ...response.data], cursor: next, pages: pages + 1 })
		return next !== null && pages + 1 < MAX_LIST_PAGES
	})
	yield* readPage.pipe(Effect.repeat({ while: (hasMore) => hasMore }))
	return (yield* Ref.get(progress)).rows
}).pipe(Effect.mapError(toLoadFailure))

/** An SLO beside its status; `status` is `null` when that one read failed. */
export interface SloListRow {
	readonly slo: V2Slo
	readonly status: V2SloStatus | null
}

/** The SLOs tab: the list, then each SLO's status, a failed status leaving its row without figures. */
export const listSloRows = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const slos = yield* listSlos
	return yield* Effect.forEach(
		slos,
		(slo) =>
			client.slos.status({ params: { id: slo.id } }).pipe(
				Effect.map((status): SloListRow => ({ slo, status })),
				Effect.orElseSucceed((): SloListRow => ({ slo, status: null })),
			),
		{ concurrency: STATUS_CONCURRENCY },
	)
})

export const retrieveSlo = (id: SloId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.slos.retrieve({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const sloStatus = (id: SloId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.slos.status({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

export const sloHistory = (id: SloId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.slos.history({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Turns the burn-rate alert on or off, keeping its destinations. */
export const setSloAlerting = (id: SloId, enabled: boolean) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const alerting = yield* Schema.decodeEffect(V2SloAlertingParams)({ enabled })
		return yield* client.slos.update({ params: { id }, payload: { alerting } })
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteSlo = (id: SloId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.slos.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Creates an SLO, or updates `editingId`; the raw payload is validated before it is sent. */
export const saveSlo = (editingId: SloId | null, raw: unknown) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		if (editingId !== null) {
			const payload = yield* Schema.decodeUnknownEffect(V2SloUpdateParams)(raw)
			return yield* client.slos.update({ params: { id: editingId }, payload })
		}
		const payload = yield* Schema.decodeUnknownEffect(V2SloCreateParams)(raw)
		return yield* client.slos.create({ payload })
	}).pipe(Effect.mapError(toLoadFailure))

/** `slos.retrieve` and `slos.status` answer this for an id the org has no SLO under. */
export const SLO_NOT_FOUND_CODE = "slo_not_found"

// LINKS

const encodePublicId = Schema.encodeSync(SloPublicId)
const decodePublicId = Schema.decodeUnknownOption(SloPublicId)
const decodeInternalId = Schema.decodeUnknownOption(SloId)

/** The `slo_…` id in a URL, or a raw UUID, as the internal id. */
export const sloIdFromUrl = (raw: string): Option.Option<SloId> =>
	Option.orElse(decodePublicId(raw), () => decodeInternalId(raw))

export const sloHref = (id: SloId): string =>
	hrefOf(AppRoute.AlertsSlo({ sloId: encodePublicId(id), search: {} }))

export const newSloHref = (search: typeof AlertsSloNewSearch.Type = {}): string =>
	hrefOf(AppRoute.AlertsSloNew({ search }))

export const editSloHref = (id: SloId): string => newSloHref({ sloId: encodePublicId(id) })

export const slosTabHref = (): string => hrefOf(AppRoute.Alerts({ search: { tab: "slos" } }))
