import { RoleKey } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { formatWarehouseDateTime, snapRangeForCache } from "@maple/query-engine"
import { Array as Arr, Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { loadServicesFacets } from "../../../data/services-facets-probe"
import { fetchSessionGrants } from "../../kit/session-grants"
import { listRoleMembers, listRoles, RoleDraft, updateRole } from "../roles/roles"
import { Message } from "./message"

export const FetchSession = fetchSessionGrants("FetchRoleEditorSession", Message.CompletedFetchSession)

export const FetchRoles = Command.define("FetchRoleEditorRoles", {
	messages: [Message.CompletedFetchRoles],
	execute: listRoles.pipe(settleTo((result) => Message.CompletedFetchRoles({ result }))),
})

export const FetchRoleMembers = Command.define("FetchRoleMembers", {
	args: { roleId: RoleKey },
	messages: [Message.CompletedFetchMembers],
	execute: ({ roleId }) =>
		listRoleMembers(roleId).pipe(settleTo((result) => Message.CompletedFetchMembers({ result }))),
})

export const SaveRole = Command.define("SaveRole", {
	args: { roleId: Policy.CustomRoleId, payload: RoleDraft, expectedUpdatedAt: Schema.Number },
	messages: [Message.CompletedSave],
	execute: ({ roleId, payload, expectedUpdatedAt }) =>
		updateRole(roleId, payload, expectedUpdatedAt).pipe(
			settleTo((result) => Message.CompletedSave({ result })),
		),
})

const NAMESPACE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000

/** The namespaces the organization reported under in the last week, for the limit's picker. */
export const FetchNamespaces = Command.define("FetchRoleEditorNamespaces", {
	messages: [Message.CompletedFetchNamespaces],
	execute: Effect.gen(function* () {
		const now = yield* Clock.currentTimeMillis
		const response = yield* loadServicesFacets(
			snapRangeForCache({
				startTime: formatWarehouseDateTime(now - NAMESPACE_WINDOW_MS),
				endTime: formatWarehouseDateTime(now),
			}),
		)
		return Arr.map(response.data.namespaces, (item) => item.name)
	}).pipe(settleTo((result) => Message.CompletedFetchNamespaces({ result }))),
})
