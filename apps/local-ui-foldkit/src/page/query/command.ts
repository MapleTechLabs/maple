import { describeQueryError, parseTables, TABLES_SQL } from "@maple/local-ui/lib/query-console"
import { executeLocalQuery } from "@maple/query-engine/local"
import { Duration, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { Message } from "./message"

// The console's side effects: the platform read, the tables list, a run and a download.

export const ReadPlatform = Command.define("ReadQueryConsolePlatform", {
	messages: [Message.CompletedReadPlatform],
	execute: Effect.sync(() => Message.CompletedReadPlatform({ isMac: /Mac|iPhone|iPad/.test(navigator.platform) })),
})

/** `QuerySidebar`'s `system.tables` read (`retry: false`). */
export const FetchTables = Command.define("FetchQueryConsoleTables", {
	args: { key: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededFetchTables, Message.FailedFetchTables],
	execute: ({ key, apiBase }) =>
		executeLocalQuery(TABLES_SQL, apiBase).pipe(
			Effect.map((rows) => Message.SucceededFetchTables({ key, tables: parseTables(rows) })),
			Effect.catch((error) =>
				Effect.succeed(Message.FailedFetchTables({ key, failure: { message: describeQueryError(error).detail } })),
			),
		),
})

/** One submission, timed like `performance.now()` around the request (`retry: false`). */
export const RunQuery = Command.define("RunQueryConsoleQuery", {
	args: { id: Schema.Number, sql: Schema.String, apiBase: Schema.String },
	messages: [Message.SucceededRunQuery, Message.FailedRunQuery],
	execute: ({ id, sql, apiBase }) =>
		executeLocalQuery(sql, apiBase).pipe(
			Effect.timed,
			Effect.map(([elapsed, rows]) => Message.SucceededRunQuery({ id, rows, elapsedMs: Duration.toMillis(elapsed) })),
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
