import { Effect, Schema, Array as Arr } from "effect"
import { UsersListCursor, UsersListRequest } from "@maple/domain/http"
import { ListUsersOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber } from "../lib/format"
import type { UserChannel } from "@maple/domain/http"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { decodeUsersRequest, groupLabel, listFilter, nameAndEmail, userLabel } from "../lib/users"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

/** Each channel's share of the user's classified requests, most first: `mcp 92%, web 8%`. */
const channelSplit = (channels: ReadonlyArray<UserChannel>): string => {
	const total = Arr.reduce(channels, 0, (sum, entry) => sum + entry.requests)
	return total === 0
		? "-"
		: Arr.join(
				Arr.map(
					channels,
					(entry) => `${entry.channel} ${Math.round((entry.requests / total) * 100)}%`,
				),
				", ",
			)
}

const TOOL = "list_users"
const WINDOW = P.timeWindow({ defaultHours: 24 * 7, maxHours: MCP_DISCOVERY_MAX_HOURS })

const decodeCursor = Schema.decodeUnknownEffect(UsersListCursor)
const encodeCursor = Schema.encodeSync(UsersListCursor)

type Filters = typeof ListUsersOutput.Type.filters

/** The filters as the parameters that set them, so a next page repeats the call. */
const filterArgs = (filters: Filters) => ({
	namespaces: filters.namespaces,
	search: filters.search,
	has_errors: filters.hasErrors,
	groups: filters.groups,
})

export function registerListUsersTool(server: McpToolRegistrar) {
	server.define({
		name: TOOL,
		title: "List Users",
		description:
			"List the end users of the org's own apps: people identified with `identify()` or a `user.id` span attribute. One row per user, most recently seen first, with sessions, requests, errors, where the requests came from (web, mobile, api, mcp) and which signals carry them (replay, events, mcp, traces, logs). Open one with `inspect_user`.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			namespaces: P.optionalList(
				"Only users seen under these service namespaces (`service.namespace`)",
			),
			search: P.optionalText("Part of a user's id, name or email (case-insensitive)"),
			has_errors: P.optionalFlag("Only users with errors or failed requests in the window"),
			groups: P.optionalList("Only users in these group ids (`identify()` group)"),
			limit: P.limit({ default: 25, max: 100, noun: "users" }),
			cursor: P.optionalText("The `nextCursor` from a previous page, to read the next one"),
		}),
		output: ListUsersOutput,
		hints: { readOnly: true },
		scopeFamily: "users",
		phrases: ["Listing users"],
		handler: Effect.fn("McpTool.listUsers")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const { limit } = params
			const namespaces = listFilter(params.namespaces)
			const groups = listFilter(params.groups)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.users.limit": limit })

			const after =
				params.cursor === undefined
					? undefined
					: yield* decodeCursor(params.cursor).pipe(
							Effect.mapError(
								() =>
									new McpInvalidInputError({
										message: `Invalid cursor: pass the \`nextCursor\` value from a previous ${TOOL} page unchanged.`,
										parameter: "cursor",
									}),
							),
						)
			const request = yield* decodeUsersRequest(UsersListRequest, TOOL, {
				startTime: st,
				endTime: et,
				limit,
				...(after !== undefined && { after }),
				...(namespaces !== undefined && { namespaces }),
				...(params.search !== undefined && { search: params.search }),
				...(params.has_errors === true && { hasErrors: true }),
				...(groups !== undefined && { groups }),
			})
			const reads = yield* UsersReadService
			const response = yield* reads
				.list(tenant, request)
				.pipe(Effect.catchTags(warehouseReadToMcpHandlers(TOOL)))
			// The read's lookahead hands back the keyset after its last row while another page exists.
			const users = response.users
			const nextCursor = response.next === undefined ? undefined : encodeCursor(response.next)
			yield* Effect.annotateCurrentSpan("result.rowCount", users.length)
			return {
				timeRange: { start: st, end: et },
				users,
				limit,
				...(nextCursor !== undefined && { nextCursor }),
				filters: {
					...(namespaces !== undefined && { namespaces }),
					...(params.search !== undefined && { search: params.search }),
					...(params.has_errors === true && { hasErrors: true }),
					...(groups !== undefined && { groups }),
				},
			}
		}),
		render: (output) => {
			const { users } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			return {
				title: "Users",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Namespaces", output.filters.namespaces?.join(", ")],
					["Search", output.filters.search],
				],
				...(users.length === 0
					? {
							empty: {
								message: "No identified users matched.",
								hints: [
									"Widen start_time/end_time, or drop filters.",
									"Users appear once an app calls identify() or sets the user.id span attribute.",
								],
							},
						}
					: undefined),
				blocks:
					users.length === 0
						? []
						: [
								doc.table(
									[
										"User",
										"Name / email",
										"Group",
										"Last seen",
										"Sessions",
										"Requests",
										"Errors",
										"Channels",
										"Signals",
									],
									Arr.map(users, (user) => [
										user.userId,
										nameAndEmail(user),
										groupLabel(user) ?? "-",
										formatWarehouseDateTime(user.lastSeenMs),
										formatNumber(user.sessions),
										formatNumber(user.requests),
										formatNumber(user.errors),
										channelSplit(user.channels),
										Arr.join(user.signals, ", "),
									]),
								),
							],
				...(output.nextCursor === undefined
					? undefined
					: {
							truncation: {
								shown: users.length,
								noun: "users (more match)",
								next: doc.next(
									TOOL,
									{
										...window,
										...filterArgs(output.filters),
										limit: output.limit,
										cursor: output.nextCursor,
									},
									"next page",
								),
							},
						}),
				next: Arr.map(
					users
						.toSorted((a, b) =>
							b.errors !== a.errors ? b.errors - a.errors : b.lastSeenMs - a.lastSeenMs,
						)
						.slice(0, 3),
					(user) =>
						doc.next(
							"inspect_user",
							{ user_id: user.userId, ...window, namespaces: output.filters.namespaces },
							user.errors > 0
								? `what went wrong for ${userLabel(user)}`
								: `what ${userLabel(user)} did`,
						),
				),
			}
		},
	})
}
