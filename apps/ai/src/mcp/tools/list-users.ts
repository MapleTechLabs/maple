import { Effect, Schema, Array as Arr } from "effect"
import { UsersListRequest } from "@maple/domain/http"
import { ListUsersOutput } from "@maple/domain/mcp-outputs"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import type { McpToolRegistrar } from "./types"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { MCP_DISCOVERY_MAX_HOURS } from "../lib/time"
import { formatNumber, truncate } from "../lib/format"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import { decodeUsersRequest, listFilter, nameAndEmail, userLabel } from "../lib/users"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const TOOL = "list_users"
const WINDOW = P.timeWindow({ defaultHours: 24 * 7, maxHours: MCP_DISCOVERY_MAX_HOURS })

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
			"List the end users of the org's own apps: people identified with `identify()` or a `user.id` span attribute. One row per user, most recently seen first, with sessions, requests, errors, busiest route and which signals carry them (replay, events, mcp, traces, logs). Open one with `inspect_user`.",
		parameters: Schema.Struct({
			...WINDOW.fields,
			namespaces: P.optionalList(
				"Only users seen under these service namespaces (`service.namespace`)",
			),
			search: P.optionalText("Part of a user's id, name or email (case-insensitive)"),
			has_errors: P.optionalFlag("Only users with errors or failed requests in the window"),
			groups: P.optionalList("Only users in these group ids (`identify()` group)"),
			limit: P.limit({ default: 25, max: 100, noun: "users" }),
			offset: P.offset({ max: 10_000 }),
		}),
		output: ListUsersOutput,
		hints: { readOnly: true },
		phrases: ["Listing users"],
		handler: Effect.fn("McpTool.listUsers")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, TOOL)
			const { limit, offset } = params
			const namespaces = listFilter(params.namespaces)
			const groups = listFilter(params.groups)
			const tenant = yield* CurrentMcpTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId, "maple.users.limit": limit })

			const request = yield* decodeUsersRequest(UsersListRequest, TOOL, {
				startTime: st,
				endTime: et,
				// One row of lookahead says whether another page exists.
				limit: limit + 1,
				offset,
				...(namespaces !== undefined && { namespaces }),
				...(params.search !== undefined && { search: params.search }),
				...(params.has_errors === true && { hasErrors: true }),
				...(groups !== undefined && { groups }),
			})
			const reads = yield* UsersReadService
			const response = yield* reads
				.list(tenant, request)
				.pipe(Effect.catchTags(warehouseReadToMcpHandlers(TOOL)))
			const hasMore = response.users.length > limit
			const users = response.users.slice(0, limit)
			yield* Effect.annotateCurrentSpan("result.rowCount", users.length)
			return {
				timeRange: { start: st, end: et },
				users,
				pagination: {
					offset,
					limit,
					hasMore,
					...(hasMore ? { nextOffset: offset + users.length } : undefined),
				},
				filters: {
					...(namespaces !== undefined && { namespaces }),
					...(params.search !== undefined && { search: params.search }),
					...(params.has_errors === true && { hasErrors: true }),
					...(groups !== undefined && { groups }),
				},
			}
		}),
		render: (output) => {
			const { users, pagination } = output
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			return {
				title: "Users",
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Namespaces", output.filters.namespaces?.join(", ")],
					["Search", output.filters.search],
					["Rows", pagination.offset > 0 ? `from ${pagination.offset + 1}` : undefined],
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
										"Top route",
										"Signals",
									],
									Arr.map(users, (user) => [
										user.userId,
										nameAndEmail(user),
										user.groupId ?? "-",
										formatWarehouseDateTime(user.lastSeenMs),
										formatNumber(user.sessions),
										formatNumber(user.requests),
										formatNumber(user.errors),
										truncate(user.topRoute ?? "-", 40),
										Arr.join(user.signals, ", "),
									]),
								),
							],
				...(pagination.nextOffset === undefined
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
										limit: pagination.limit,
										offset: pagination.nextOffset,
									},
									"next page",
								),
							},
						}),
				next: Arr.map(
					users.toSorted((a, b) => b.errors - a.errors || b.lastSeenMs - a.lastSeenMs).slice(0, 3),
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
