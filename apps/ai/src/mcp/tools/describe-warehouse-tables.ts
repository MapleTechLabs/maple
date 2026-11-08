import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema, Array as Arr, String as Str } from "effect"
import { DescribeWarehouseTablesOutput } from "@maple/domain/mcp-outputs"
import {
	describeWarehouseTable,
	listWarehouseTables,
	suggestWarehouseTables,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import * as P from "../lib/params"
import { doc, type DocBlock, type ToolDoc } from "../lib/tool-doc"

const TOOL = "describe_warehouse_tables"

type Output = typeof DescribeWarehouseTablesOutput.Type
type Described = NonNullable<Output["described"]>[number]

/** More would bury the columns an agent asked for under ones it did not. */
const MAX_TABLES = 5

/** `["trace_list_mv"]` arrives as one comma-split item when a client JSON-encodes the list. */
const tableNames = (raw: ReadonlyArray<string>): ReadonlyArray<string> =>
	Arr.dedupe(
		Arr.filter(
			Arr.map(raw, (name) => Str.trim(Str.replace(/[[\]"'`]/g, "")(name))),
			(name) => name !== "",
		),
	)

const describe = (name: string) => {
	const info = describeWarehouseTable(name)
	if (info === null) {
		const names = Arr.map(listWarehouseTables(), (t) => t.name)
		const suggested = suggestWarehouseTables(name)
		const hint =
			suggested.length === 0
				? ""
				: ` Did you mean ${Arr.join(
						Arr.map(suggested, (t) => `"${t}"`),
						" or ",
					)}?`
		return Effect.fail(
			new McpInvalidInputError({
				message: `No table named "${name}".${hint} Available tables: ${Arr.join(names, ", ")}.`,
				parameter: "tables",
			}),
		)
	}
	const sortingKey =
		info.sortingKey === undefined
			? undefined
			: typeof info.sortingKey === "string"
				? [info.sortingKey]
				: [...info.sortingKey]
	return Effect.succeed<Described>({
		name: info.name,
		...(info.description === undefined ? undefined : { description: info.description }),
		columns: Arr.map(info.columns, (c) => ({
			name: c.name,
			type: c.type,
			...(c.jsonPath === undefined ? undefined : { jsonPath: c.jsonPath }),
		})),
		...(sortingKey === undefined ? undefined : { sortingKey }),
		...(info.notes === undefined ? undefined : { notes: [...info.notes] }),
	})
}

const renderTable = (info: Described): ToolDoc => {
	const blocks: Array<DocBlock> = []
	if (info.description !== undefined) blocks.push(doc.text(info.description))
	blocks.push(
		doc.heading("Columns"),
		doc.list(
			Arr.map(
				info.columns,
				(c) =>
					`\`${c.name}\`: ${c.type}${c.jsonPath === undefined ? "" : ` (jsonPath: \`${c.jsonPath}\`)`}`,
			),
		),
	)
	if (info.sortingKey !== undefined && info.sortingKey.length > 0) {
		blocks.push(
			doc.heading("Sorting key"),
			doc.text(`\`(${Arr.join(info.sortingKey, ", ")})\`: filter on these for fast queries.`),
		)
	}
	if (info.notes !== undefined && info.notes.length > 0) {
		blocks.push(doc.heading("Notes"), doc.list(info.notes))
	}
	return { title: `\`${info.name}\``, blocks }
}

export function registerDescribeWarehouseTablesTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "Describe Warehouse Tables",
		description:
			"Table and column catalog for raw warehouse SQL (run_sql, raw_sql widgets, raw_query alert rules). With no arguments it lists every table; with `tables` it gives those tables' columns, sorting key and notes on enum casing, units and the columns rollups lack. Read it before writing SQL rather than guessing names.",
		parameters: Schema.Struct({
			tables: P.optionalList(`Tables whose columns and notes to return (at most ${MAX_TABLES})`),
		}),
		aliases: { table: "tables" },
		output: DescribeWarehouseTablesOutput,
		hints: { readOnly: true },
		phrases: ["Reading table schemas", "Describing warehouse tables"],
		handler: Effect.fn("McpTool.describeWarehouseTables")(function* ({ tables }) {
			const names = tableNames(tables ?? [])
			if (names.length > 0) {
				if (names.length > MAX_TABLES) {
					return yield* new McpInvalidInputError({
						message: `Ask for at most ${MAX_TABLES} tables at a time; got ${names.length}.`,
						parameter: "tables",
					})
				}
				return { described: yield* Effect.forEach(names, describe) }
			}
			return {
				tables: Arr.map(listWarehouseTables(), (t) => ({
					name: t.name,
					...(t.description === undefined ? undefined : { description: t.description }),
					columnCount: t.columnCount,
					...(t.timeColumn === undefined ? undefined : { timeColumn: t.timeColumn }),
				})),
			}
		}),
		render: (output) => {
			const [only, ...more] = output.described ?? []
			if (only !== undefined && more.length === 0) return renderTable(only)
			if (only !== undefined) {
				return {
					title: `${more.length + 1} warehouse tables`,
					blocks: Arr.flatMap([only, ...more], (info) => {
						const one = renderTable(info)
						return [doc.heading(one.title), ...(one.blocks ?? [])]
					}),
				}
			}
			const tables = output.tables ?? []
			return {
				title: `Warehouse tables (${tables.length})`,
				blocks: [
					doc.table(
						["Table", "Time column", "Description", "Columns"],
						Arr.map(tables, (t) => [
							t.name,
							t.timeColumn ?? "-",
							t.description ?? "-",
							String(t.columnCount),
						]),
					),
				],
				next: Arr.map(tables.slice(0, 1), (t) =>
					doc.next(TOOL, { tables: [t.name] }, "the full column list and notes for a table"),
				),
			}
		},
	})
}
