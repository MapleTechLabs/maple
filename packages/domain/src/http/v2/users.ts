import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/http-api"
import { Schema } from "effect"
import { AuditedRead } from "../audit-log"
import { ErrorPersistenceError, WorkflowState } from "../errors"
import { McpClientKind, McpSessionSource } from "../mcp"
import { UserSignalKind } from "../users"
import { AuthorizationV2 } from "./auth"
import { ListOf, ListQuery, Timestamp, wireExample } from "./envelopes"
import { defineV2Error, V2ParameterInvalid, V2TimeRangeInvalid } from "./errors"
import { publicErrors } from "./public-error"
import { V2WarehouseReadErrors } from "./query-errors"
import { ErrorIssuePublicId } from "./resource-ids"
import { SessionReplayPublicId } from "./session-replays"
import { V2TelemetryRangeTooLarge } from "./telemetry"

// End users: the people an org's own apps identified with `identify()` or a `user.id` attribute.
// A user's id is the app's own opaque string, so it passes through like a trace id, never prefixed.

/** An end user's id as the SDK sent it, matched exactly. URL-encode it in the path. */
export const V2EndUserId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)).annotate({
	title: "End user ID",
	description: "The id the app identified the user with (`identify()` or the `user.id` attribute).",
	examples: ["user_2abc"],
})

const nullableText = (description: string) => Schema.NullOr(Schema.String).annotate({ description })
const count = (description: string) => Schema.Number.annotate({ description })
const nullableCount = (description: string) => Schema.NullOr(Schema.Number).annotate({ description })

const userIdentityFields = {
	id: V2EndUserId,
	object: Schema.Literal("user").annotate({
		description: 'The object type, always `"user"`.',
		examples: ["user"],
	}),
	name: nullableText("The display name `identify()` sent, or `null`."),
	email: nullableText("The email `identify()` sent, or `null`."),
	group_id: nullableText("The group (company, team or tenant) the user belongs to, or `null`."),
	first_seen_at: Timestamp.annotate({ description: "The user's first signal in the window." }),
	last_seen_at: Timestamp.annotate({ description: "The user's latest signal in the window." }),
	session_count: count("Browser sessions the user had in the window."),
	top_route: nullableText("The user's busiest route, or `null` without requests."),
	activity: Schema.Array(Schema.Number).annotate({
		description:
			"Requests in 7 equal slices of the window, oldest first. Empty where the cluster has no per-user request rollup.",
	}),
	signals: Schema.Array(UserSignalKind).annotate({
		description: "The signals Maple holds for the user: `replay`, `events`, `mcp`, `traces`, `logs`.",
	}),
} as const

export const V2User = Schema.Struct({
	...userIdentityFields,
	namespaces: Schema.Array(Schema.String).annotate({
		description: "The service namespaces the user was seen under.",
	}),
	error_count: count("Errors recorded in the user's browser sessions, plus their failed requests."),
	request_count: count("Entry-point requests that carried the user's id."),
}).annotate({
	identifier: "User",
	title: "User",
	description: "An end user of the org's own apps, summarized over the requested window.",
	examples: [
		wireExample({
			id: "user_2abc",
			object: "user",
			name: "Ada Lovelace",
			email: "ada@acme.com",
			group_id: "acme",
			first_seen_at: "2026-11-01T08:00:00.000Z",
			last_seen_at: "2026-11-04T17:42:10.000Z",
			session_count: 6,
			top_route: "GET /checkout",
			activity: [3, 0, 12, 8, 0, 4, 21],
			signals: ["replay", "traces", "logs"],
			namespaces: ["storefront"],
			error_count: 2,
			request_count: 48,
		}),
	],
})
export type V2User = Schema.Schema.Type<typeof V2User>

export const V2UserDevice = Schema.Struct({
	browser: Schema.String,
	os: Schema.String,
	session_count: Schema.Number,
}).annotate({ identifier: "UserDevice", title: "User device" })

export const V2UserService = Schema.Struct({
	service_name: Schema.String,
	namespace: nullableText("The service's namespace, or `null` when the service map does not know it."),
	signal_count: count("Sessions, events, requests and log lines from the service."),
}).annotate({ identifier: "UserService", title: "User service" })

export const V2UserProfile = Schema.Struct({
	...userIdentityFields,
	traits: Schema.Record(Schema.String, Schema.String).annotate({
		description: "`identify()` traits from the user's latest session.",
	}),
	visitor_ids: Schema.Array(Schema.String).annotate({
		description: "Browser visitor ids linked to the user before sign-in.",
	}),
	recorded_ms: count("Recorded session time in ms."),
	replay_error_count: count("Errors the browser SDK recorded in the user's sessions."),
	event_count: count("Product events the user sent."),
	distinct_event_count: count("Distinct product event names."),
	mcp_request_count: count("Requests the user made to MCP servers."),
	mcp_call_count: count("MCP tool calls the user made."),
	devices: Schema.Array(V2UserDevice),
	country: nullableText("The sessions' country (ISO code), or `null`."),
	services: Schema.Array(V2UserService).annotate({ description: "The services the user touched." }),
	request_count: nullableCount(
		"Entry-point requests. `null` where the cluster has no per-user request rollup, never a fake zero.",
	),
	failed_request_rate: nullableCount("Failed requests over requests, 0 to 1; `null` without requests."),
	p95_duration_ms: nullableCount("p95 request latency in ms; `null` without requests."),
	trace_count: nullableCount("Distinct traces the user's spans belong to."),
	log_count: nullableCount("Log lines that carried the user's id."),
	issue_count: nullableCount("Distinct error issues the user hit."),
	issue_hit_count: nullableCount("Error occurrences that named the user."),
}).annotate({
	identifier: "UserProfile",
	title: "User profile",
	description: "One end user's identity and totals over the requested window.",
	examples: [
		wireExample({
			id: "user_2abc",
			object: "user",
			name: "Ada Lovelace",
			email: "ada@acme.com",
			group_id: "acme",
			first_seen_at: "2026-11-01T08:00:00.000Z",
			last_seen_at: "2026-11-04T17:42:10.000Z",
			session_count: 6,
			top_route: "GET /checkout",
			activity: [3, 0, 12, 8, 0, 4, 21],
			signals: ["replay", "mcp", "traces", "logs"],
			traits: { plan: "pro" },
			visitor_ids: ["visitor_123"],
			recorded_ms: 1260000,
			replay_error_count: 1,
			event_count: 40,
			distinct_event_count: 7,
			mcp_request_count: 12,
			mcp_call_count: 9,
			devices: [{ browser: "Chrome", os: "macOS", session_count: 6 }],
			country: "GB",
			services: [{ service_name: "storefront-web", namespace: "storefront", signal_count: 52 }],
			request_count: 48,
			failed_request_rate: 0.04,
			p95_duration_ms: 812,
			trace_count: 45,
			log_count: 130,
			issue_count: 2,
			issue_hit_count: 3,
		}),
	],
})
export type V2UserProfile = Schema.Schema.Type<typeof V2UserProfile>

export const V2UserSession = Schema.Struct({
	id: SessionReplayPublicId,
	service_name: Schema.String,
	start_time: Timestamp,
	duration_ms: Schema.Number,
	page_views: Schema.Number,
	error_count: Schema.Number,
	entry_path: Schema.String,
	device: Schema.String.annotate({ description: '`"Chrome · macOS"`, or `""` when the SDK sent neither.' }),
}).annotate({
	identifier: "UserSession",
	title: "User session",
	description: "One browser session of the user; open it with `GET /v2/session_replays/{id}`.",
})

export const V2UserEvent = Schema.Struct({
	timestamp: Timestamp,
	name: Schema.String,
	source: Schema.String.annotate({ description: "`browser`, `server`, `mobile` or `trace`." }),
	service_name: Schema.String,
	detail: Schema.String.annotate({
		description: "The page path, else the first properties as `key=value`.",
	}),
}).annotate({ identifier: "UserEvent", title: "User event" })

export const V2UserMcpSession = Schema.Struct({
	service_name: Schema.String.annotate({ description: "The MCP server the session ran on." }),
	session_id: Schema.String.annotate({ description: "The server's MCP session id." }),
	source: McpSessionSource.annotate({
		description: "`issued`: the server issued the session id. `user`: split from the user's requests.",
	}),
	client: Schema.String.annotate({ description: "The MCP client name." }),
	client_kind: McpClientKind,
	request_count: Schema.Number,
	call_count: Schema.Number.annotate({ description: "Tool calls in the session." }),
	error_count: Schema.Number,
	tool_count: Schema.Number.annotate({ description: "Distinct tools called." }),
	first_seen_at: Timestamp,
	last_seen_at: Timestamp,
}).annotate({ identifier: "UserMcpSession", title: "User MCP session" })

export const V2UserActivityKind = Schema.Literals(["session", "event", "mcp", "error", "request", "log"])

export const V2UserActivityEntry = Schema.Struct({
	kind: V2UserActivityKind,
	timestamp: Timestamp,
	service_name: Schema.String,
	title: Schema.String,
	detail: Schema.String,
	tone: Schema.Literals(["crit", "warn", "neutral"]).annotate({
		description: "`crit` for failures, `warn` for slow requests and warnings.",
	}),
	session_replay_id: Schema.NullOr(SessionReplayPublicId).annotate({
		description: "The session a `session` entry opens, else `null`.",
	}),
	mcp_session_id: nullableText("The MCP session an `mcp` entry opens, else `null`."),
	trace_id: nullableText("The trace a `request` or `log` entry opens, else `null`."),
	issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The issue an `error` entry opens, else `null`.",
	}),
}).annotate({ identifier: "UserActivityEntry", title: "User activity entry" })

export const V2UserActivity = Schema.Struct({
	object: Schema.Literal("user.activity").annotate({
		description: 'The object type, always `"user.activity"`.',
	}),
	user_id: V2EndUserId,
	sessions: Schema.Array(V2UserSession).annotate({
		description: "Browser sessions, newest first, capped.",
	}),
	events: Schema.Array(V2UserEvent).annotate({ description: "Product events, newest first, capped." }),
	mcp_sessions: Schema.Array(V2UserMcpSession).annotate({
		description: "MCP sessions on every MCP server in scope, latest first, capped.",
	}),
	timeline: Schema.Array(V2UserActivityEntry).annotate({
		description:
			"Sessions, events, MCP sessions, issues hit, failed or slow requests and warn/error logs merged, latest first, capped at 200.",
	}),
}).annotate({
	identifier: "UserActivity",
	title: "User activity",
	description: "What one end user did in the window, as lists and one merged timeline.",
})
export type V2UserActivity = Schema.Schema.Type<typeof V2UserActivity>

export const V2UserIssue = Schema.Struct({
	object: Schema.Literal("user.issue").annotate({ description: 'The object type, always `"user.issue"`.' }),
	issue_id: Schema.NullOr(ErrorIssuePublicId).annotate({
		description: "The error issue, or `null` for a fingerprint not yet promoted to one.",
	}),
	fingerprint_hash: Schema.String,
	type: Schema.String,
	message: Schema.String,
	service_name: Schema.String,
	hit_count: count("Occurrences that named this user."),
	first_seen_at: Timestamp,
	last_seen_at: Timestamp,
	workflow_state: Schema.NullOr(WorkflowState),
}).annotate({ identifier: "UserIssue", title: "User issue", description: "An error issue the user hit." })
export type V2UserIssue = Schema.Schema.Type<typeof V2UserIssue>

const UserIssueListEnvelope = ListOf(V2UserIssue)

export const V2UserIssueList = Schema.Struct({
	...UserIssueListEnvelope.fields,
	attributed: Schema.Boolean.annotate({
		description:
			"`false` on a cluster whose error events predate user attribution: no error can name a user, so the empty list says nothing.",
	}),
}).annotate({
	identifier: "UserIssueList",
	title: "User issue list",
	description: "A page of the issues one user hit, most hits first.",
})

// Requests

const UsersWindow = {
	start_time: Timestamp.annotate({ description: "Window start (ISO-8601). Required." }),
	end_time: Timestamp.annotate({
		description: "Window end (ISO-8601). Required; at most 31 days after start.",
	}),
	namespace: Schema.optional(
		Schema.String.annotate({
			description:
				"Only these service namespaces, comma-separated (`storefront,billing`). Omit for every namespace.",
		}),
	),
} as const

export const V2UserListQuery = Schema.Struct({
	...ListQuery.fields,
	...UsersWindow,
	q: Schema.optional(
		Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
			description: "Case-insensitive substring of the user's id, name or email.",
		}),
	),
	has_errors: Schema.optional(
		Schema.Literal("true").annotate({ description: "Only users with errors in the window." }),
	),
	group: Schema.optional(
		Schema.String.annotate({ description: "Only users in these group ids, comma-separated." }),
	),
}).annotate({ identifier: "UserListQuery", title: "User list query" })
export type V2UserListQuery = Schema.Schema.Type<typeof V2UserListQuery>

export const V2UserWindowQuery = Schema.Struct(UsersWindow).annotate({
	identifier: "UserWindowQuery",
	title: "User window query",
})

export const V2UserIssuesQuery = Schema.Struct({ ...ListQuery.fields, ...UsersWindow }).annotate({
	identifier: "UserIssuesQuery",
	title: "User issues query",
})

export const V2UserNotFound = defineV2Error({
	tag: "@maple/http/v2/UserNotFoundError",
	status: 404,
	code: "user_not_found",
	title: "User not found",
	message: "No signal in the window and namespaces carries this user.",
	retry: "never",
	recovery: "fix_request",
	identifier: "UserNotFoundError",
})

const windowErrors = [
	V2ParameterInvalid.schema,
	V2TimeRangeInvalid.schema,
	V2TelemetryRangeTooLarge.schema,
	...V2WarehouseReadErrors,
] as const

// The issue reads resolve fingerprints to issues in Postgres.
const [errorPersistence] = publicErrors(ErrorPersistenceError)

const UserList = ListOf(V2User).annotate({
	identifier: "UserList",
	title: "User list",
	description: "A page of end users, most recently seen first.",
})

export class V2UsersApiGroup extends HttpApiGroup.make("users")
	.add(
		HttpApiEndpoint.get("list", "/", {
			query: V2UserListQuery,
			success: UserList,
			error: windowErrors,
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listUsers",
				summary: "List users",
				description:
					"Lists the end users seen in a window (browser sessions, product events, MCP sessions, spans and logs that carried a user id), most recently seen first. Cursor-paginated. Requires `users:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("retrieve", "/:user_id", {
			params: { user_id: V2EndUserId },
			query: V2UserWindowQuery,
			success: V2UserProfile,
			error: [...windowErrors, errorPersistence, V2UserNotFound.schema],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getUser",
				summary: "Retrieve a user",
				description:
					"Returns one end user's identity, devices, services and request, log and issue totals over a window. A user with no signal in the window is `user_not_found`. Requires `users:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("activity", "/:user_id/activity", {
			params: { user_id: V2EndUserId },
			query: V2UserWindowQuery,
			success: V2UserActivity,
			error: [...windowErrors, errorPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "getUserActivity",
				summary: "Retrieve a user's activity",
				description:
					"Returns one end user's browser sessions, product events and MCP sessions, plus a timeline that merges them with the issues they hit, failed or slow requests and warning logs. Each list is capped. Requires `users:read`.",
			}),
		),
	)
	.add(
		HttpApiEndpoint.get("issues", "/:user_id/issues", {
			params: { user_id: V2EndUserId },
			query: V2UserIssuesQuery,
			success: V2UserIssueList,
			error: [...windowErrors, errorPersistence],
		}).annotateMerge(
			OpenApi.annotations({
				identifier: "listUserIssues",
				summary: "List a user's issues",
				description:
					"Lists the error issues one end user hit in a window, most hits first (at most 100). Cursor-paginated. Requires `users:read`.",
			}),
		),
	)
	.prefix("/v2/users")
	.middleware(AuthorizationV2)
	.annotate(AuditedRead, "telemetry.read")
	.annotateMerge(
		OpenApi.annotations({
			title: "Users",
			description:
				"The end users of your own apps, identified with `identify()` or a `user.id` attribute: who they are, what they did, and the errors they hit.",
		}),
	) {}
