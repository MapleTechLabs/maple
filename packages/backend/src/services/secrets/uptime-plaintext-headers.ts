/**
 * Seals the request headers of HTTP uptime checks that still hold them in `config_json`:
 * monitors saved before headers were sealed, or by a Worker not yet deployed with sealing.
 */
import * as Orm from "@maple-dev/effect-orm/database"
import { Array as Arr, Effect, Schema } from "effect"
import { sealSecret } from "@maple/backend/platform/SecretBox"
import { uptimeMonitorHeadersSlot } from "@maple/backend/platform/secret-slots"
import { UptimeHeadersJson } from "@maple/backend/services/uptime/uptime-headers"
import {
	PendingCountRow,
	SecretResealError,
	WrittenRow,
	type PendingSecret,
	type ResealTarget,
} from "./reseal-targets"

const PlaintextRow = Schema.Struct({
	keys: Schema.fromJsonString(Schema.Tuple([Schema.String, Schema.String])),
	headers: Schema.String,
})

const decodeHeaders = Schema.decodeEffect(UptimeHeadersJson)
const resealError = (message: string) => new SecretResealError({ message })

const hasPlaintextHeaders = Orm.sql`kind = 'http'
	and jsonb_typeof(config_json -> 'headers') = 'object'
	and config_json -> 'headers' <> '{}'::jsonb`

const toPending = (row: typeof PlaintextRow.Type): PendingSecret => {
	const [orgId, id] = row.keys
	return {
		keys: row.keys,
		reseal: (keyring) =>
			decodeHeaders(row.headers).pipe(
				Effect.mapError(() => resealError("Stored headers are not a string map")),
				Effect.flatMap(() =>
					sealSecret(keyring, uptimeMonitorHeadersSlot, { orgId, id }, row.headers, resealError),
				),
			),
		write: (db, sealed) =>
			db
				.query(
					Orm.sql`
						update uptime_monitors
						set headers_ciphertext = ${sealed.ciphertext}, headers_iv = ${sealed.iv},
							headers_tag = ${sealed.tag},
							config_json = jsonb_set(config_json, '{headers}', '{}'::jsonb)
						where org_id = ${orgId} and id = ${id}
							and config_json -> 'headers' = ${row.headers}::jsonb
						returning 1 as written`,
					WrittenRow,
				)
				.pipe(Effect.map((rows) => rows.length > 0)),
	}
}

export const uptimePlaintextHeadersTarget: ResealTarget = {
	slotName: `${uptimeMonitorHeadersSlot.name} (in config_json)`,
	pending: (db, _prefix, cursor, limit) =>
		db
			.query(
				Orm.sql`
					select jsonb_build_array(org_id, id)::text as keys,
						(config_json -> 'headers')::text as headers
					from uptime_monitors
					where ${hasPlaintextHeaders}${
						cursor === null
							? Orm.sql.empty
							: Orm.sql` and (org_id, id) > (${Orm.sql.join(cursor)})`
					}
					order by org_id, id
					limit ${limit}`,
				PlaintextRow,
			)
			.pipe(Effect.map(Arr.map(toPending))),
	countPending: (db) =>
		db
			.query(
				Orm.sql`select count(*)::text as pending from uptime_monitors where ${hasPlaintextHeaders}`,
				PendingCountRow,
			)
			.pipe(Effect.map((rows) => rows[0]?.pending ?? 0)),
}
