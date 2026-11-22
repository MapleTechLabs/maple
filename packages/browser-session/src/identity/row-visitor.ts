import { isCookieless } from "../platform/persistence"
import { mayIdentifyVisitor } from "./consent"
import { getVisitorId, isVisitorOptedOut } from "./visitor"

/**
 * The `visitor_id` cookieless rows carry. The ingest gateway replaces it with a
 * hash of a daily rotating salt, the org, the client IP and the user agent.
 */
export const COOKIELESS_VISITOR_ID = "cookieless"

/**
 * The `visitor_id` every row sends: the stored id, the cookieless sentinel, or
 * `""` when a visitor identifier is refused (consent, GPC, DNT, opt-out).
 */
export function rowVisitorId(): string {
	if (!isCookieless()) return getVisitorId() ?? ""
	return mayIdentifyVisitor() && !isVisitorOptedOut() ? COOKIELESS_VISITOR_ID : ""
}
