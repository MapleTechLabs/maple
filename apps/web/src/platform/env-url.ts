import { String as Str } from "effect"

/** A configured URL env var, trimmed and without a trailing slash; `undefined` when unset or blank. */
export const envUrl = (configured: string | undefined): string | undefined => {
	const trimmed = configured === undefined ? undefined : Str.trim(configured)
	return trimmed === undefined || trimmed.length === 0 ? undefined : Str.replace(/\/$/, "")(trimmed)
}
