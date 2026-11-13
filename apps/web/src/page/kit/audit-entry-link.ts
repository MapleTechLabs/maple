import { DateTime } from "effect"
import { AppRoute, hrefOf } from "../../route"

/**
 * The Settings audit log ending at one entry, with that entry open. Newest first, so the entry
 * heads the first page however busy the minute was, and the minute before it follows as context.
 */
export const auditEntryHref = (
	occurredAtMs: number,
	/** The entry's public `alog_…` id. */
	entry: string,
	until: string = DateTime.formatIso(DateTime.makeUnsafe(occurredAtMs)),
): string =>
	hrefOf(
		AppRoute.Settings({
			search: {
				tab: "audit-log",
				kind: "all",
				since: DateTime.formatIso(DateTime.makeUnsafe(occurredAtMs - 60_000)),
				until,
				entry,
			},
		}),
	)
