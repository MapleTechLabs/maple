import { Array as Arr, String as Str } from "effect"
/** snake_case / kebab-case / spaced identifier to "Title Case": `query_data` -> "Query Data". */
export function humanize(value: string): string {
	return Arr.join(
		Arr.map(
			Arr.filter(Str.split(/[-_\s]+/)(value), Boolean),
			(word) => Str.toUpperCase(Str.slice(0, 1)(word)) + Str.slice(1)(word),
		),
		" ",
	)
}
