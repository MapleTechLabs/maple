import {
	AlertSilenceDocument,
	AlertSilenceMatchers,
	alertSilenceMatches,
	alertSilenceStatusAt,
	type AlertSilenceId,
	type AlertSilenceTarget,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertSilences, type AlertSilenceRow } from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, Option, Order, Schema } from "effect"

const decodeMatchers = Schema.decodeUnknownOption(AlertSilenceMatchers)
const decodeDocument = Schema.decodeUnknownSync(AlertSilenceDocument)

const silenceEndOrder = Order.mapInput(Order.Number, (row: StoredSilenceRow) => row.endsAt)

const iso = (ms: number) => new Date(ms).toISOString()

/** A silence row with its matchers left undecoded, so an old or newer shape cannot fail the read. */
export type StoredSilenceRow = Omit<AlertSilenceRow, "matchersJson"> & { readonly matchersJson: unknown }

export const selectSilences = () =>
	PG.from(AlertSilences).select(($) => ({ ...$, matchersJson: PG.undecoded($.matchersJson) }))

/** A stored row the current schema cannot read matches nothing, rather than everything. */
export const silenceRowMatchers = (row: StoredSilenceRow): Option.Option<AlertSilenceMatchers> =>
	decodeMatchers(row.matchersJson)

export const silenceRowToDocument = (
	row: StoredSilenceRow,
	nowMs: number,
): Option.Option<AlertSilenceDocument> =>
	Option.map(silenceRowMatchers(row), (matchers) =>
		decodeDocument({
			id: row.id,
			reason: row.reason,
			matchers,
			status: alertSilenceStatusAt({ startsAtMs: row.startsAt, endsAtMs: row.endsAt }, nowMs),
			startsAt: iso(row.startsAt),
			endsAt: iso(row.endsAt),
			createdBy: row.createdBy,
			createdAt: iso(row.createdAt),
			updatedAt: iso(row.updatedAt),
		}),
	)

/** The org's silences in force at `atMs`, served by `alert_silences_org_ends_idx`. */
export const selectActiveSilences = (db: MapleDb, orgId: OrgId, atMs: number) =>
	db.run(selectSilences().where(($) => [$.orgId.eq(orgId), $.endsAt.gt(atMs), $.startsAt.lte(atMs)]))

export interface MatchedSilence {
	readonly id: AlertSilenceId
	readonly reason: string
}

/** The first of `silences` that covers `target`; the earliest-ending wins so the record names the shortest hold. */
export const firstMatchingSilence = (
	silences: ReadonlyArray<StoredSilenceRow>,
	target: AlertSilenceTarget,
): MatchedSilence | null => {
	const matching = Arr.filter(silences, (row) =>
		Option.match(silenceRowMatchers(row), {
			onNone: () => false,
			onSome: (matchers) => alertSilenceMatches(matchers, target),
		}),
	)
	const first = Arr.head(Arr.sort(matching, silenceEndOrder))
	return Option.match(first, {
		onNone: () => null,
		onSome: (row) => ({ id: row.id, reason: row.reason }),
	})
}
