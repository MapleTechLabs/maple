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
			"Discover ClickHouse tables and columns available for the `raw_sql_chart` widget path of `add_dashboard_widget` (and any other ad-hoc warehouse SQL). Call with no arguments to list every table (name, description, column count). Pass `table` to get the full column list (`name`, `type`, optional `jsonPath`) plus hand-curated notes (enum casing, units, sort-key hints) for that table. Use this BEFORE writing raw SQL so you don't hallucinate table or column names.",
		parameters: Schema.Struct({
			table: P.optionalText(
				"Optional table name. If provided, returns full column list and notes for that table. If omitted, lists every available table with a short description.",
			),
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
