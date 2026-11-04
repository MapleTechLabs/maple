// The end user a span or log belongs to, for `user_activity_hourly` and `error_events.UserId`.
// OpenTelemetry `user.id`, else the deprecated `enduser.id`; the same resolution the MCP hub reads.

const userIdFrom = (attributes: string): string =>
	`if(${attributes}['user.id'] != '', ${attributes}['user.id'], ${attributes}['enduser.id'])`

export const SPAN_USER_ID_SQL = userIdFrom("SpanAttributes")
export const LOG_USER_ID_SQL = userIdFrom("LogAttributes")

export const SERVICE_NAMESPACE_SQL = "ResourceAttributes['service.namespace']"
