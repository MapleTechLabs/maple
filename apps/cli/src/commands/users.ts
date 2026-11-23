import * as Command from "effect/cli/Command"
import * as Argument from "effect/cli/Argument"
import * as Flag from "effect/cli/Flag"
import { Effect, Option, Array as Arr } from "effect"
import * as f from "../lib/flags"
import { formatCount, formatTimestamp, printResult, renderFields, renderTable } from "../lib/output"
import { describeWindow, resolveRangeChecked } from "../core/time"
import * as Ops from "../core/operations"

// End users and product events of the org's own apps. Both read a workspace's users directory
// through its MCP tools, so they run in remote mode only.

const isoOf = (ms: number): string => formatTimestamp(new Date(ms).toISOString())

export const users = Command.make("users", {
	since: Flag.String("since").pipe(
		Flag.withDescription("Relative window ending now: 30m, 6h, 7d, 2w (default: 7d)"),
		Flag.withDefault("7d"),
	),
	start: f.start,
	end: f.end,
	search: Flag.optional(
		Flag.String("search").pipe(
			Flag.withAlias("q"),
			Flag.withDescription("Part of a user's id, name or email"),
		),
	),
	errors: Flag.Boolean("errors").pipe(
		Flag.withDescription("Only users with errors or failed requests"),
		Flag.withDefault(false),
	),
	group: Flag.String("group").pipe(
		Flag.withDescription("Only users in this group (account) id, repeatable"),
		Flag.atLeast(0),
	),
	property: Flag.String("property").pipe(
		Flag.withAlias("p"),
		Flag.withDescription(
			"Only users whose user property matches, repeatable: key=value, or key alone for any value",
		),
		Flag.atLeast(0),
	),
	limit: f.limitWithDefault(25),
	cursor: Flag.optional(
		Flag.String("cursor").pipe(Flag.withDescription("The nextCursor of a previous page")),
	),
}).pipe(
	Command.withDescription(
		"List the end users your apps identified (identify() or a user.id attribute), most recently seen first",
	),
	Command.withExamples([
		{ command: "maple users --format table", description: "Users seen in the last 7 days" },
		{ command: "maple users -p plan=pro --errors", description: "Pro-plan users who hit errors" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.listUsers({
				range,
				search: Option.getOrUndefined(a.search),
				errorsOnly: a.errors,
				groups: a.group,
				properties: a.property,
				limit: a.limit,
				cursor: Option.getOrUndefined(a.cursor),
			})
			yield* printResult(result, {
				empty: `No identified users in ${describeWindow(a, range)}`,
				isEmpty: (data) => data.users.length === 0,
				table: (data) => [
					{
						body: renderTable(
							[
								{ header: "USER", cell: (u) => u.userId, maxWidth: 40 },
								{ header: "NAME", cell: (u) => u.name ?? u.email ?? "", maxWidth: 32 },
								{
									header: "GROUP",
									cell: (u) => u.groupName ?? u.groupId ?? "",
									maxWidth: 24,
								},
								{ header: "LAST SEEN", cell: (u) => isoOf(u.lastSeenMs) },
								{ header: "SESSIONS", cell: (u) => formatCount(u.sessions), align: "right" },
								{ header: "REQUESTS", cell: (u) => formatCount(u.requests), align: "right" },
								{ header: "ERRORS", cell: (u) => formatCount(u.errors), align: "right" },
							],
							data.users,
						),
					},
				],
				notes: (data) =>
					data.nextCursor === undefined
						? []
						: [
								// The window is pinned: `--since` would resolve against a later now on the next run.
								`More users: rerun with the same filters plus --start '${range.startTime}' --end '${range.endTime}' --cursor ${data.nextCursor}`,
							],
			})
		}),
	),
)

export const user = Command.make("user", {
	userId: Argument.String("user-id").pipe(
		Argument.withDescription("The user's id, as `maple users` lists it"),
	),
	since: Flag.String("since").pipe(
		Flag.withDescription("Relative window ending now: 30m, 6h, 7d, 2w (default: 7d)"),
		Flag.withDefault("7d"),
	),
	start: f.start,
	end: f.end,
}).pipe(
	Command.withDescription(
		"One end user: identity, properties, sessions, product events, issues and failed requests",
	),
	Command.withExamples([
		{ command: "maple user user_123 --format table", description: "A user's profile" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.inspectUser({ userId: a.userId, range })
			yield* printResult(result, {
				empty: `No signal for ${a.userId} in ${describeWindow(a, range)}`,
				isEmpty: (data) => data.profile === null,
				table: (data) => {
					const profile = data.profile
					if (profile === null) return []
					const fields: ReadonlyArray<readonly [string, string]> = [
						["user", profile.userId],
						["name", profile.name ?? ""],
						["email", profile.email ?? ""],
						["group", profile.groupName ?? profile.groupId ?? ""],
						["first seen", isoOf(profile.firstSeenMs)],
						["last seen", isoOf(profile.lastSeenMs)],
						["sessions", formatCount(profile.sessions)],
						["events", formatCount(profile.events)],
					]
					return [
						{ body: renderFields(fields) },
						...(profile.traits.length === 0
							? []
							: [
									{
										title: "Properties",
										body: renderFields(
											Arr.map(profile.traits, (t) => [t.key, t.value] as const),
										),
									},
								]),
						...(data.events.length === 0
							? []
							: [
									{
										title: "Recent events",
										body: renderTable(
											[
												{ header: "AT", cell: (e) => isoOf(e.atMs) },
												{ header: "EVENT", cell: (e) => e.name, maxWidth: 48 },
											],
											data.events,
										),
									},
								]),
						...(data.issues.length === 0
							? []
							: [
									{
										title: "Issues",
										body: renderTable(
											[
												{
													header: "ISSUE",
													cell: (i) => `${i.type}: ${i.message}`,
													maxWidth: 60,
												},
												{
													header: "HITS",
													cell: (i) => formatCount(i.hits),
													align: "right",
												},
											],
											data.issues,
										),
									},
								]),
						...(data.failedRequests.length === 0
							? []
							: [
									{
										title: "Failed requests",
										body: renderTable(
											[
												{ header: "AT", cell: (r) => isoOf(r.atMs) },
												{ header: "SERVICE", cell: (r) => r.service, maxWidth: 24 },
												{ header: "REQUEST", cell: (r) => r.title, maxWidth: 48 },
												{ header: "DETAIL", cell: (r) => r.detail, maxWidth: 40 },
												{ header: "TRACE", cell: (r) => r.traceId ?? "" },
											],
											data.failedRequests,
										),
									},
								]),
					]
				},
			})
		}),
	),
)

export const events = Command.make("events", {
	since: Flag.String("since").pipe(
		Flag.withDescription("Relative window ending now: 30m, 6h, 7d, 2w (default: 7d)"),
		Flag.withDefault("7d"),
	),
	start: f.start,
	end: f.end,
	kind: Flag.optional(
		Flag.Literals("kind", ["custom", "navigation", "screen"]).pipe(
			Flag.withDescription(
				"custom (track() or server events), navigation (page views) or screen (mobile)",
			),
		),
	),
	search: Flag.optional(
		Flag.String("search").pipe(Flag.withAlias("q"), Flag.withDescription("Part of the event name")),
	),
	limit: f.limitWithDefault(50),
}).pipe(
	Command.withDescription(
		"Product event names (track(), server-side events, page views) with counts, sessions, people and accounts",
	),
	Command.withExamples([
		{ command: "maple events --kind custom --format table", description: "Custom events this week" },
		{ command: "maple events -q signup --since 30d", description: "Events whose name contains signup" },
	]),
	Command.withHandler(
		Effect.fnUntraced(function* (a) {
			const range = yield* resolveRangeChecked(a)
			const result = yield* Ops.listProductEvents({
				range,
				kind: Option.getOrUndefined(a.kind),
				search: Option.getOrUndefined(a.search),
				limit: a.limit,
			})
			yield* printResult(result, {
				empty: `No product events in ${describeWindow(a, range)}`,
				isEmpty: (data) => data.events.length === 0,
			})
		}),
	),
)
