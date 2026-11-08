import { ExternalDataSourceId } from "@maple/domain/data-sources"
import {
	V2CatalogEntryUpdateParams,
	V2DataSourceCreateParams,
	V2DataSourceUpdateParams,
} from "@maple/domain/http/v2"
import { Effect, Result, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { readAllPages } from "../../../platform/read-all-pages"
import { Message } from "./model"

// The tab's reads and writes against `/v2/data_sources`.

/** Runs a client call and answers with its result; failures become the public error body. */
const settle =
	<A, B>(toMessage: (result: Result.Result<A, ReturnType<typeof toLoadFailure>>) => B) =>
	<E, R>(effect: Effect.Effect<A, E, R>) =>
		effect.pipe(Effect.mapError(toLoadFailure), Effect.result, Effect.map(toMessage))

/** Every source, page by page, so none past the first page is hidden. */
export const listSources = Effect.flatMap(MapleApiV2Client, (client) =>
	readAllPages((cursor) => client.dataSources.list({ query: { limit: 100, cursor } })),
)

export const FetchSources = Command.define("FetchDataSources", {
	messages: [Message.CompletedFetchSources],
	execute: listSources.pipe(settle((result) => Message.CompletedFetchSources({ result }))),
})

export const CreateSource = Command.define("CreateDataSource", {
	args: { payload: V2DataSourceCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ payload }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.dataSources.create({ payload })).pipe(
			settle((result) => Message.CompletedSave({ result })),
		),
})

export const UpdateSource = Command.define("UpdateDataSource", {
	args: { id: ExternalDataSourceId, payload: V2DataSourceUpdateParams },
	messages: [Message.CompletedSave],
	execute: ({ id, payload }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.dataSources.update({ params: { id }, payload }),
		).pipe(settle((result) => Message.CompletedSave({ result }))),
})

export const TestSource = Command.define("TestDataSource", {
	args: { id: ExternalDataSourceId, key: Schema.String },
	messages: [Message.CompletedTest],
	execute: ({ id, key }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.dataSources.test({ params: { id } })).pipe(
			settle((result) => Message.CompletedTest({ id: key, result })),
		),
})

export const FetchCatalog = Command.define("FetchDataSourceCatalog", {
	args: { id: ExternalDataSourceId },
	messages: [Message.CompletedFetchCatalog],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.dataSources.catalog({ params: { id } })).pipe(
			settle((result) => Message.CompletedFetchCatalog({ id, result })),
		),
})

export const RefreshCatalog = Command.define("RefreshDataSourceCatalog", {
	args: { id: ExternalDataSourceId },
	messages: [Message.CompletedRefreshCatalog],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.dataSources.refreshCatalog({ params: { id } }),
		).pipe(settle((result) => Message.CompletedRefreshCatalog({ id, result }))),
})

export const UpdateCatalogEntry = Command.define("UpdateDataSourceCatalogEntry", {
	/** `fromEditor`: the open editor's save, which closes it only once the write succeeds. */
	args: {
		id: ExternalDataSourceId,
		entry: Schema.String,
		payload: V2CatalogEntryUpdateParams,
		fromEditor: Schema.Boolean,
	},
	messages: [Message.CompletedUpdateEntry],
	execute: ({ id, entry, payload, fromEditor }) =>
		Effect.flatMap(MapleApiV2Client, (client) =>
			client.dataSources.updateCatalogEntry({ params: { id, entry }, payload }),
		).pipe(settle((result) => Message.CompletedUpdateEntry({ name: entry, fromEditor, result }))),
})

export const DeleteSource = Command.define("DeleteDataSource", {
	args: { id: ExternalDataSourceId },
	messages: [Message.CompletedDelete],
	execute: ({ id }) =>
		Effect.flatMap(MapleApiV2Client, (client) => client.dataSources.delete({ params: { id } })).pipe(
			Effect.asVoid,
			settle((result) => Message.CompletedDelete({ result })),
		),
})
