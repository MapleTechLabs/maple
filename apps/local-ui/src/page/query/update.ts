import type { Resources } from "../../platform/resources"
import { toCsv, toJson } from "../../lib/query-console"
import { Option, Result } from "effect"
import type { Command, Update } from "foldkit"
import { accept, acceptCached, idle, keyOf, request } from "../../data/slot"
import { queryOf } from "../../route"
import { type PageContext, PageOutMessage, replaceParams } from "../contract"
import { DownloadText, FetchTables, ReadPlatform, RunQuery } from "./command"
import { Message } from "./message"
import { type LocalTable, type Model, RunState } from "./model"

export type UpdateReturn = Update.ReturnWithOutMessage<Model, Message, PageOutMessage, Resources>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>

const TABLES_KEY = keyOf("query-console", "tables")

export const init = (context: PageContext): Readonly<{ model: Model; commands: Commands }> => {
	const empty = idle<ReadonlyArray<LocalTable>>()
	const tables = Option.getOrElse(request(empty, TABLES_KEY), () => empty)
	return {
		model: { _tag: "QueryPage", isMac: false, tables, run: RunState.Idle(), nextRunId: 0 },
		commands: [
			ReadPlatform(),
			FetchTables({ key: TABLES_KEY, apiBase: context.env.apiBase, readsCache: true }),
		],
	}
}

/** The console reads its SQL straight from the fragment, so a hash change needs nothing here. */
export const locationChanged = (model: Model, _context: PageContext): UpdateReturn => ({ model })

const sqlOf = (context: PageContext): string => queryOf(context.location).get("sql") ?? ""

/** `run`: a fresh id per submission, so a remount is never served an older answer. */
const run = (model: Model, context: PageContext): UpdateReturn => {
	const text = sqlOf(context).trim()
	if (text === "") return { model }
	const id = model.nextRunId
	return {
		model: { ...model, run: RunState.Running({ id, sql: text }), nextRunId: id + 1 },
		commands: [RunQuery({ id, sql: text, apiBase: context.env.apiBase })],
	}
}

const isCurrentRun = (model: Model, id: number): boolean =>
	model.run._tag === "Running" && model.run.id === id

const rowsOf = (model: Model) => (model.run._tag === "Succeeded" ? model.run.rows : [])

export const update = (model: Model, message: Message, context: PageContext): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		CompletedReadPlatform: ({ isMac }) => ({ model: { ...model, isMac } }),
		SucceededFetchTables: ({ key, tables, fetchedAtMs }) => ({
			model: { ...model, tables: accept(model.tables, key, Result.succeed(tables), fetchedAtMs) },
		}),
		FoundCachedTables: ({ key, cached }) => ({
			model: { ...model, tables: acceptCached(model.tables, key, cached, cached.isFresh) },
			commands:
				cached.isFresh || model.tables.key !== key
					? []
					: [FetchTables({ key, apiBase: context.env.apiBase, readsCache: false })],
		}),
		FailedFetchTables: ({ key, failure }) => ({
			model: { ...model, tables: accept(model.tables, key, Result.fail(failure)) },
		}),
		ChangedSql: ({ text }) => ({ model, outMessage: replaceParams(context.location, { sql: text }) }),
		ClickedPickSql: ({ sql }) => ({ model, outMessage: replaceParams(context.location, { sql }) }),
		ClickedRun: () => run(model, context),
		// `cancelQueries`: the console goes idle; the root stops the run's request (`lanes.ts`).
		ClickedCancel: () =>
			model.run._tag !== "Running" ? { model } : { model: { ...model, run: RunState.Idle() } },
		SucceededRunQuery: ({ id, rows, elapsedMs }) =>
			model.run._tag === "Running" && isCurrentRun(model, id)
				? {
						model: {
							...model,
							run: RunState.Succeeded({ id, sql: model.run.sql, rows, elapsedMs }),
						},
					}
				: { model },
		FailedRunQuery: ({ id, title, detail }) =>
			model.run._tag === "Running" && isCurrentRun(model, id)
				? { model: { ...model, run: RunState.Failed({ id, sql: model.run.sql, title, detail }) } }
				: { model },
		ClickedDownload: ({ format }) => {
			const rows = rowsOf(model)
			if (rows.length === 0) return { model }
			return {
				model,
				commands: [
					format === "Csv"
						? DownloadText({ filename: "maple-query.csv", text: toCsv(rows), type: "text/csv" })
						: DownloadText({
								filename: "maple-query.json",
								text: toJson(rows),
								type: "application/json",
							}),
				],
			}
		},
		CompletedDownload: () => ({ model }),
		ClickedOpenFilters: () => ({ model, outMessage: PageOutMessage.RequestedFilterDrawer() }),
	})
