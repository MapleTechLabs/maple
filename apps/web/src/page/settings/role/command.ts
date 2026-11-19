import { UpdateRoleRequest } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Array as Arr, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import { fetchSessionGrants } from "../../kit/session-grants"
import { memberDisplayName } from "../kit/members"
import { listRoleMembers, listRoles, updateRole } from "../roles/roles"
import { Message } from "./message"
import type { RoleMember } from "./model"

export const FetchSession = fetchSessionGrants("FetchRoleEditorSession", Message.CompletedFetchSession)

export const FetchRoles = Command.define("FetchRoleEditorRoles", {
	messages: [Message.CompletedFetchRoles],
	execute: listRoles.pipe(settleTo((result) => Message.CompletedFetchRoles({ result }))),
})

export const FetchCustomRoleMembers = Command.define("FetchCustomRoleMembers", {
	args: { roleId: Policy.CustomRoleId },
	messages: [Message.CompletedFetchMembers],
	execute: ({ roleId }) =>
		listRoleMembers(roleId).pipe(
			Effect.map((response) =>
				Arr.map(response.members, (member): RoleMember => ({
					userId: member.userId,
					name: member.name ?? member.identifier,
					identifier: member.identifier,
					imageUrl: member.imageUrl ?? "",
				})),
			),
			settleTo((result) => Message.CompletedFetchMembers({ result })),
		),
})

/** Clerk's page cap: a built-in role's first hundred holders. */
const MEMBERS_PAGE_SIZE = 100

/** A built-in role's holders come from Clerk, filtered by the role. */
export const FetchBuiltInRoleMembers = Command.define("FetchBuiltInRoleMembers", {
	args: { clerkKey: Schema.String },
	messages: [Message.CompletedFetchMembers],
	execute: ({ clerkKey }) =>
		currentClerkOrganization.pipe(
			Effect.flatMap((organization) =>
				clerkTry("Couldn't load members", () =>
					organization.getMemberships({ role: [clerkKey], pageSize: MEMBERS_PAGE_SIZE }),
				),
			),
			Effect.map((page) =>
				Arr.map(page.data, (member): RoleMember => ({
					userId: member.publicUserData?.userId ?? member.id,
					name:
						memberDisplayName(member.publicUserData) ??
						member.publicUserData?.identifier ??
						"Unknown",
					identifier: member.publicUserData?.identifier ?? "",
					imageUrl: member.publicUserData?.hasImage === true ? member.publicUserData.imageUrl : "",
				})),
			),
			settleTo((result) => Message.CompletedFetchMembers({ result })),
		),
})

export const SaveRole = Command.define("SaveRole", {
	args: { roleId: Policy.CustomRoleId, payload: UpdateRoleRequest },
	messages: [Message.CompletedSave],
	execute: ({ roleId, payload }) =>
		updateRole(roleId, payload).pipe(settleTo((result) => Message.CompletedSave({ result }))),
})
