import { RoleKey } from "@maple/domain/http"
import * as Policy from "@maple/domain/policy"
import { Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
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
