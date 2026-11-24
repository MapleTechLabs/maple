/**
 * Why an incident resolved when no check said so. A notification shows the note in place of
 * "back within its threshold", which would be untrue.
 */
import { String as Str } from "effect"

export const DELETED_RULE_RESOLVE_DETAIL = "Resolved: the alert was deleted"

const MANUAL_RESOLVE_PREFIX = "Resolved by "

/** "Resolved by Dana Kim"; a click from an unnamed account reads "a teammate". */
export const manualResolveNote = (name: string | null): string =>
	`${MANUAL_RESOLVE_PREFIX}${name ?? "a teammate"}`

export const isResolutionNote = (detail: string | null | undefined): detail is string =>
	detail != null && (detail === DELETED_RULE_RESOLVE_DETAIL || Str.startsWith(MANUAL_RESOLVE_PREFIX)(detail))
