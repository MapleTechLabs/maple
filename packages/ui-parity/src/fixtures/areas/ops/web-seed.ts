import { Effect } from "effect"
import { sharedChdb } from "../../../backend/chdb.ts"
import type { WarehouseRow } from "../../telemetry/rows.ts"
import { FROZEN_NOW_MS } from "../../identity.ts"
import { webSessionRows } from "./web-sessions.ts"

/**
 * The browser-session tables are outside the shared telemetry seed (`TELEMETRY_TABLES`), so this
 * area inserts them itself, into the process's chDB and only for `ACME_WEB_ORG`. chDB calls are
 * synchronous, so the rows are in place before the backend answers its first request.
 */

const insert = (table: string, rows: ReadonlyArray<WarehouseRow>) =>
	Effect.flatMap(sharedChdb, (chdb) =>
		rows.length === 0
			? Effect.void
			: chdb.run(
					`INSERT INTO ${table} FORMAT JSONEachRow\n${rows.map((row) => JSON.stringify(row)).join("\n")}`,
				),
	)

/** Once per process, like the telemetry seed: chDB outlives every backend started in it. */
export const seedWebSessions: Effect.Effect<void, unknown> = Effect.runSync(
	Effect.cached(
		Effect.gen(function* () {
			const rows = webSessionRows(FROZEN_NOW_MS)
			yield* insert("session_replays", rows.session_replays)
			yield* insert("session_events", rows.session_events)
			yield* insert("session_replay_events", rows.session_replay_events)
		}),
	),
)
