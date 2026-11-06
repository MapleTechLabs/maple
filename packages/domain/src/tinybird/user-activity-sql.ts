// The end user a span or log belongs to, for `user_activity_hourly` and `error_events.UserId`.
// OpenTelemetry `user.id`, else the deprecated `enduser.id`; the same resolution the MCP hub reads.

const userIdFrom = (attributes: string): string =>
	`if(${attributes}['user.id'] != '', ${attributes}['user.id'], ${attributes}['enduser.id'])`

export const SPAN_USER_ID_SQL = userIdFrom("SpanAttributes")
export const LOG_USER_ID_SQL = userIdFrom("LogAttributes")

export const SERVICE_NAMESPACE_SQL = "ResourceAttributes['service.namespace']"

// Which client sent a request, for `user_activity_hourly`'s Web and Mobile request counts; the
// rest are API requests, MCP is told apart at read time by the MCP servers' service names.
const SPAN_USER_AGENT_SQL =
	"if(SpanAttributes['user_agent.original'] != '', SpanAttributes['user_agent.original'], SpanAttributes['http.user_agent'])"

/** A browser: a browser SDK's own span, or a server span whose caller sent a browser user agent. */
export const WEB_REQUEST_SQL = `(ResourceAttributes['maple.sdk.type'] IN ('browser', 'client') OR ${SPAN_USER_AGENT_SQL} LIKE 'Mozilla/%')`

/** A native mobile app (and not a browser): its SDK, or Android's and Apple's HTTP stack user agents. */
export const MOBILE_REQUEST_SQL = `(NOT ${WEB_REQUEST_SQL} AND (ResourceAttributes['telemetry.sdk.language'] IN ('swift', 'kotlin') OR ResourceAttributes['os.name'] IN ('iOS', 'iPadOS', 'Android') OR match(${SPAN_USER_AGENT_SQL}, '^(Dalvik|okhttp)/| CFNetwork/')))`
