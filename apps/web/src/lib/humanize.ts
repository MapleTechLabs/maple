/** snake_case / kebab-case / spaced identifier to "Title Case": `query_data` -> "Query Data". */
export function humanize(value: string): string {
	return value
		.split(/[-_\s]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(" ")
}
