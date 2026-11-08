import { Array as Arr, Option, Order, String as Str } from "effect"
import type { CatalogEntry, CatalogExample } from "@maple/domain/data-sources"

const PLAIN_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
const isPlain = (name: string) => Arr.every(Str.split(".")(name), (part) => PLAIN_RE.test(part))

const bySize = Order.flip(Order.mapInput(Order.Number, (entry: CatalogEntry) => entry.rowEstimate ?? 0))

const sql = (title: string, text: string): CatalogExample => ({ title, query: { _tag: "sql", sql: text } })

/** Worked examples over the largest table with a time field; none when no table qualifies. */
export const catalogExamples = (entries: ReadonlyArray<CatalogEntry>): ReadonlyArray<CatalogExample> => {
	const candidates = Arr.filter(
		entries,
		(entry) => entry.timeField !== undefined && isPlain(entry.name) && isPlain(entry.timeField),
	)
	return Option.match(Arr.head(Arr.sort(candidates, bySize)), {
		onNone: () => [],
		onSome: (entry) => {
			const time = entry.timeField ?? ""
			const category = Arr.findFirst(
				entry.fields,
				(field) =>
					field.sampleValues !== undefined && field.name !== time && PLAIN_RE.test(field.name),
			)
			const byCategory = Option.match(category, {
				onNone: () => [],
				onSome: (field) => [
					sql(
						`Rows by ${field.name} in ${entry.name}`,
						`SELECT ${field.name}, count() AS rows\nFROM ${entry.name}\nWHERE $__timeFilter(${time})\nGROUP BY ${field.name}\nORDER BY rows DESC`,
					),
				],
			})
			return [
				sql(
					`Rows over time in ${entry.name}`,
					`SELECT $__timeGroup(${time}) AS time, count() AS rows\nFROM ${entry.name}\nWHERE $__timeFilter(${time})\nGROUP BY time\nORDER BY time`,
				),
				...byCategory,
				sql(
					`Latest rows in ${entry.name}`,
					`SELECT *\nFROM ${entry.name}\nWHERE $__timeFilter(${time})\nORDER BY ${time} DESC\nLIMIT 20`,
				),
			]
		},
	})
}
