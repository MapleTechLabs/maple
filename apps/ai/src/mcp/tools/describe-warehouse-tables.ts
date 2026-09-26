import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DescribeWarehouseTablesOutput } from "@maple/domain/mcp-outputs"
import {
	describeWarehouseTable,
	listWarehouseTables,
} from "@maple/backend/services/warehouse/warehouse-catalog"
import * as P from "../lib/params"
import { doc, type DocBlock, type ToolDoc } from "../lib/tool-doc"

const TOOL = "describe_warehouse_tables"

type Output = typeof DescribeWarehouseTablesOutput.Type

const renderTable = (info: NonNullable<Output["table"]>): ToolDoc => {
	const blocks: Array<DocBlock> = []
	if (info.description !== undefined) blocks.push(doc.text(info.description))
	blocks.push(
		doc.heading("Columns"),
		doc.list(
			info.columns.map(
				(c) =>
					`\`${c.name}\`: ${c.type}${c.jsonPath === undefined ? "" : ` (jsonPath: \`${c.jsonPath}\`)`}`,
			),
		),
	)
	if (info.sortingKey !== undefined && info.sortingKey.length > 0) {
		blocks.push(
			doc.heading("Sorting key"),
			doc.text(`\`(${info.sortingKey.join(", ")})\`: filter on these for fast queries.`),
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
		description:
			"Table and column catalog for raw warehouse SQL (run_sql, raw_sql widgets, raw_query alert rules). With no arguments it lists every table; with `table` it gives that table's columns, sorting key and notes on enum casing and units. Read it before writing SQL rather than guessing names.",
		parameters: Schema.Struct({
			table: P.optionalText("Table whose columns and notes to return"),
		}),
		output: DescribeWarehouseTablesOutput,
		hints: { readOnly: true },
		phrases: ["Reading table schemas", "Describing warehouse tables"],
		handler: Effect.fn("McpTool.describeWarehouseTables")(function* ({ table }) {
			if (table !== undefined) {
				const info = describeWarehouseTable(table)
				if (info === null) {
					const names = listWarehouseTables().map((t) => t.name)
					return yield* new McpInvalidInputError({
						message: `No table named "${table}". Available tables: ${names.join(", ")}.`,
						parameter: "table",
					})
				}
				const sortingKey =
					info.sortingKey === undefined
						? undefined
						: typeof info.sortingKey === "string"
							? [info.sortingKey]
							: [...info.sortingKey]
				return {
					table: {
						name: info.name,
						...(info.description === undefined ? undefined : { description: info.description }),
						columns: info.columns.map((c) => ({
							name: c.name,
							type: c.type,
							...(c.jsonPath === undefined ? undefined : { jsonPath: c.jsonPath }),
						})),
						...(sortingKey === undefined ? undefined : { sortingKey }),
						...(info.notes === undefined ? undefined : { notes: [...info.notes] }),
					},
				}
			}
			return {
				tables: listWarehouseTables().map((t) => ({
					name: t.name,
					...(t.description === undefined ? undefined : { description: t.description }),
					columnCount: t.columnCount,
				})),
			}
		}),
		render: (output) => {
			if (output.table !== undefined) return renderTable(output.table)
			const tables = output.tables ?? []
			return {
				title: `Warehouse tables (${tables.length})`,
				blocks: [
					doc.table(
						["Table", "Description", "Columns"],
						tables.map((t) => [t.name, t.description ?? "-", String(t.columnCount)]),
					),
				],
				next: tables
					.slice(0, 1)
					.map((t) =>
						doc.next(TOOL, { table: t.name }, "the full column list and notes for one table"),
					),
			}
		},
	})
}
