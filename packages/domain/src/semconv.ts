/**
 * Deprecated -> current OpenTelemetry attribute keys. Readers accept both spellings (warehouse
 * expressions, span display); the attribute recommendations propose the `span` renames as mappings.
 */
import { Record as Rec } from "effect"

export interface SemconvRename {
	/** The current OpenTelemetry semantic-convention key. */
	readonly canonical: string
	/** One-line, human-readable explanation of the rename. */
	readonly reason: string
	/** Whether the source key is a deprecated semconv key or a camelCase mistake. */
	readonly category: "deprecated" | "camelcase"
	/** Where the key lives. The ingest mapper can only write span keys, so only those are proposed. */
	readonly scope: "span" | "resource"
}

/** Keyed by the deprecated spelling, in recommendation order. */
export const SEMCONV_RENAMES = {
	// HTTP
	"http.method": {
		canonical: "http.request.method",
		reason: "HTTP semconv renamed the request method attribute.",
		category: "deprecated",
		scope: "span",
	},
	"http.status_code": {
		canonical: "http.response.status_code",
		reason: "Response status moved under the http.response.* namespace.",
		category: "deprecated",
		scope: "span",
	},
	"http.url": {
		canonical: "url.full",
		reason: "Full request URL moved to the dedicated url.* namespace.",
		category: "deprecated",
		scope: "span",
	},
	"http.target": {
		canonical: "url.path",
		reason: "Request target split into url.path (and url.query).",
		category: "deprecated",
		scope: "span",
	},
	"http.scheme": {
		canonical: "url.scheme",
		reason: "Scheme moved to the url.* namespace.",
		category: "deprecated",
		scope: "span",
	},
	"http.host": {
		canonical: "server.address",
		reason: "Host attribute generalized to server.address.",
		category: "deprecated",
		scope: "span",
	},
	"http.flavor": {
		canonical: "network.protocol.version",
		reason: "Protocol version generalized under network.*.",
		category: "deprecated",
		scope: "span",
	},
	"http.request_content_length": {
		canonical: "http.request.body.size",
		reason: "Renamed in the stable HTTP semconv.",
		category: "deprecated",
		scope: "span",
	},
	"http.response_content_length": {
		canonical: "http.response.body.size",
		reason: "Renamed in the stable HTTP semconv.",
		category: "deprecated",
		scope: "span",
	},
	"http.user_agent": {
		canonical: "user_agent.original",
		reason: "User agent moved to the user_agent.* namespace.",
		category: "deprecated",
		scope: "span",
	},
	// Network / socket
	"net.peer.name": {
		canonical: "server.address",
		reason: "Peer name generalized to server.address.",
		category: "deprecated",
		scope: "span",
	},
	"net.peer.port": {
		canonical: "server.port",
		reason: "Peer port generalized to server.port.",
		category: "deprecated",
		scope: "span",
	},
	"net.host.name": {
		canonical: "server.address",
		reason: "Host name generalized to server.address.",
		category: "deprecated",
		scope: "span",
	},
	"net.host.port": {
		canonical: "server.port",
		reason: "Host port generalized to server.port.",
		category: "deprecated",
		scope: "span",
	},
	"net.sock.peer.addr": {
		canonical: "network.peer.address",
		reason: "Socket peer address moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	"net.sock.peer.port": {
		canonical: "network.peer.port",
		reason: "Socket peer port moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	"net.transport": {
		canonical: "network.transport",
		reason: "Transport moved to the network.* namespace.",
		category: "deprecated",
		scope: "span",
	},
	"net.protocol.name": {
		canonical: "network.protocol.name",
		reason: "Protocol name moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	"net.protocol.version": {
		canonical: "network.protocol.version",
		reason: "Protocol version moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	// Database
	"db.statement": {
		canonical: "db.query.text",
		reason: "Database semconv renamed the statement attribute.",
		category: "deprecated",
		scope: "span",
	},
	"db.operation": {
		canonical: "db.operation.name",
		reason: "Renamed in the stable database semconv.",
		category: "deprecated",
		scope: "span",
	},
	"db.system": {
		canonical: "db.system.name",
		reason: "Database system attribute namespaced as db.system.name.",
		category: "deprecated",
		scope: "span",
	},
	"db.name": {
		canonical: "db.namespace",
		reason: "Database name generalized to db.namespace.",
		category: "deprecated",
		scope: "span",
	},
	"db.sql.table": {
		canonical: "db.collection.name",
		reason: "Table/collection name generalized to db.collection.name.",
		category: "deprecated",
		scope: "span",
	},
	// Messaging
	"messaging.destination": {
		canonical: "messaging.destination.name",
		reason: "Destination namespaced under messaging.destination.*.",
		category: "deprecated",
		scope: "span",
	},
	"messaging.url": {
		canonical: "server.address",
		reason: "Broker URL generalized to server.address.",
		category: "deprecated",
		scope: "span",
	},
	"messaging.protocol": {
		canonical: "network.protocol.name",
		reason: "Messaging protocol moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	"messaging.protocol_version": {
		canonical: "network.protocol.version",
		reason: "Messaging protocol version moved to network.*.",
		category: "deprecated",
		scope: "span",
	},
	// FaaS / user
	"faas.execution": {
		canonical: "faas.invocation_id",
		reason: "FaaS execution id renamed to faas.invocation_id.",
		category: "deprecated",
		scope: "span",
	},
	"enduser.id": {
		canonical: "user.id",
		reason: "Enduser attributes consolidated under user.*.",
		category: "deprecated",
		scope: "span",
	},
	// Common camelCase mistakes with a confident canonical target
	httpMethod: {
		canonical: "http.request.method",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	httpStatusCode: {
		canonical: "http.response.status_code",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	httpUrl: {
		canonical: "url.full",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	httpRoute: {
		canonical: "http.route",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	dbStatement: {
		canonical: "db.query.text",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	dbOperation: {
		canonical: "db.operation.name",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	userId: {
		canonical: "user.id",
		reason: "Non-conforming camelCase key — use the dotted semconv name.",
		category: "camelcase",
		scope: "span",
	},
	// Resource attributes: readers coalesce both spellings; the ingest mapper cannot rename these.
	"deployment.environment": {
		canonical: "deployment.environment.name",
		reason: "Deployment environment moved to deployment.environment.name.",
		category: "deprecated",
		scope: "resource",
	},
	"container.runtime": {
		canonical: "container.runtime.name",
		reason: "Semconv v1.37.0 renamed the container runtime attribute.",
		category: "deprecated",
		scope: "resource",
	},
} as const satisfies Record<string, SemconvRename>

export type SemconvDeprecatedKey = keyof typeof SEMCONV_RENAMES

/** Every rename as a row, with the deprecated key alongside. */
export const SEMCONV_RENAME_ROWS: ReadonlyArray<SemconvRename & { readonly deprecated: string }> =
	Rec.collect(SEMCONV_RENAMES, (deprecated, rename: SemconvRename) => ({ deprecated, ...rename }))

/** Both spellings of a renamed key, current first. */
export const currentThenDeprecated = <K extends SemconvDeprecatedKey>(key: K) =>
	[SEMCONV_RENAMES[key].canonical, key] as const

/** Both spellings of a renamed key, deprecated first. */
export const deprecatedThenCurrent = <K extends SemconvDeprecatedKey>(key: K) =>
	[key, SEMCONV_RENAMES[key].canonical] as const
