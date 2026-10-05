// Display lengths for the ids we print shortened. One table, so a trace id is
// the same 8 characters on the list, the peek sheet and the breadcrumb.

export type IdKind = "trace" | "span" | "sha" | "session" | "generic"

export const ID_DISPLAY_LENGTH: Record<IdKind, number> = {
	trace: 8,
	span: 8,
	sha: 7,
	session: 12,
	generic: 12,
} satisfies Record<IdKind, number>

/** Shorten an id for display. `ellipsis` appends "…" when something was cut. */
export function shortId(
	value: string,
	kind: IdKind = "generic",
	options: { length?: number; ellipsis?: boolean } = {},
): string {
	const length = options.length ?? ID_DISPLAY_LENGTH[kind]
	if (value.length <= length) return value
	return options.ellipsis ? `${value.slice(0, length)}…` : value.slice(0, length)
}
