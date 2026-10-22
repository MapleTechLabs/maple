import { describeQueryError, parseTables, TABLES_SQL } from "../../lib/query-console"
import { executeLocalQuery } from "@maple/query-engine/local"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { cachedAs, withCache } from "../../data/cached"
import { Message } from "./message"
import { LocalTable } from "./model"

// The console's side effects: the platform read, the tables list, a run and a download.

export const ReadPlatform = Command.define("ReadQueryConsolePlatform", {
	messages: [Message.CompletedReadPlatform],
	execute: Effect.sync(() =>
		Message.CompletedReadPlatform({ isMac: /Mac|iPhone|iPad/.test(navigator.platform) }),
	),
})

/** `QuerySidebar`'s `system.tables` read (`retry: false`), opened on its cached list first. */
export const FetchTables = Command.define("FetchQueryConsoleTables", {
	args: { key: Schema.String, apiBase: Schema.String, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchTables, Message.FailedFetchTables, Message.FoundCachedTables],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, apiBase, readsCache }) =>
		withCache({
			key: ["local", "query-console", "tables"],
			readsCache,
			fromCached: cachedAs(Schema.Array(LocalTable)),
			toCached: (tables: ReadonlyArray<LocalTable>) => tables,
			fetch: Effect.map(executeLocalQuery(TABLES_SQL, apiBase), (rows): ReadonlyArray<LocalTable> =>
				parseTables(rows),
			),
			found: (cached) => Message.FoundCachedTables({ key, cached }),
			succeeded: (tables, fetchedAtMs) => Message.SucceededFetchTables({ key, tables, fetchedAtMs }),
		}).pipe(
			Effect.catch((error) =>
				Effect.succeed(
					Message.FailedFetchTables({
						key,
						failure: { message: describeQueryError(error).detail },
					}),
				),
			),
		),
})

/** One submission, timed like `performance.now()` around the request (`retry: false`); Cancel interrupts it. */
export const RunQuery = Command.define("RunQueryConsoleQuery", {
	args: { id: Schema.Number, sql: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededRunQuery, Message.FailedRunQuery],
	interrupt: { keyFields: ["id"], toKey: ({ id }) => String(id) },
	execute: ({ id, sql, apiBase }) =>
		executeLocalQuery(sql, apiBase).pipe(
			Effect.timed,
			Effect.map(([elapsed, rows]) =>
				Message.SucceededRunQuery({ id, rows, elapsedMs: Duration.toMillis(elapsed) }),
			),
			Effect.catch((error) => {
				const { title, detail } = describeQueryError(error)
				return Effect.succeed(Message.FailedRunQuery({ id, title, detail }))
			}),
		),
})

/** `downloadText`: save text as a file; the object URL is released right after. */
export const DownloadText = Command.define("DownloadQueryConsoleText", {
	args: { filename: Schema.String, text: Schema.String, type: Schema.String },
	messages: [Message.CompletedDownload],
	execute: ({ filename, text, type }) =>
		Effect.sync(() => {
			const url = URL.createObjectURL(new Blob([text], { type }))
			const anchor = document.createElement("a")
			anchor.href = url
			anchor.download = filename
			anchor.click()
			URL.revokeObjectURL(url)
			return Message.CompletedDownload()
		}),
})
