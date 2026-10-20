import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import { CachedOf } from "../../data/cached"
import { LoadFailure } from "../../data/local-query"
import { LocalTable, ResultRow } from "./model"

export const DownloadFormat = Schema.Literals(["Csv", "Json"])
export type DownloadFormat = typeof DownloadFormat.Type

export const Message = defineMessageUnion({
	CompletedReadPlatform: { isMac: Schema.Boolean },
	SucceededFetchTables: { key: Schema.String, tables: Schema.Array(LocalTable), fetchedAtMs: Schema.Number },
	/** The result cache held the tables list before the fetch ran. */
	FoundCachedTables: { key: Schema.String, cached: CachedOf(Schema.Array(LocalTable)) },
	FailedFetchTables: { key: Schema.String, failure: LoadFailure },
	ChangedSql: { text: Schema.String },
	ClickedPickSql: { sql: Schema.String },
	ClickedRun: {},
	ClickedCancel: {},
	SucceededRunQuery: { id: Schema.Number, rows: Schema.Array(ResultRow), elapsedMs: Schema.Number },
	FailedRunQuery: { id: Schema.Number, title: Schema.String, detail: Schema.String },
	ClickedDownload: { format: DownloadFormat },
	CompletedDownload: {},
	ClickedOpenFilters: {},
})
export type Message = typeof Message.Type
