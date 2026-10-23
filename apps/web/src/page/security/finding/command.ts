import { SecurityAuditFindingTriageStatus } from "@maple/domain/http"
import { SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readIsAdmin } from "../../alerts/shared/commands"
import { listFindings, listTargets, updateFindingStatus } from "../kit/api"
import { Message } from "./model"

// The finding page's reads and its one write. Names start with `SecurityApi` so the lab can drop them.

export const ReadFindingClock = Command.define("ReadSecurityFindingClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const ReadFindingIsAdmin = Command.define("ReadSecurityFindingIsAdmin", {
	messages: [Message.CompletedReadIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedReadIsAdmin({ isAdmin })),
})

export const FetchTargetFindings = Command.define("SecurityApiListTargetFindings", {
	args: { key: Schema.String, targetId: SecurityAuditTargetId },
	messages: [Message.CompletedFetchFindings],
	execute: ({ key, targetId }) =>
		Effect.map(listFindings(targetId), (result) => Message.CompletedFetchFindings({ key, result })),
})

export const FetchFindingTargets = Command.define("SecurityApiListFindingTargets", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchTargets],
	execute: ({ key }) => Effect.map(listTargets, (result) => Message.CompletedFetchTargets({ key, result })),
})

export const UpdateFindingStatus = Command.define("SecurityApiUpdateFindingStatus", {
	args: {
		targetId: SecurityAuditTargetId,
		fingerprint: Schema.String,
		status: SecurityAuditFindingTriageStatus,
		reason: Schema.String,
	},
	messages: [Message.CompletedTriage],
	execute: ({ targetId, fingerprint, status, reason }) =>
		Effect.map(updateFindingStatus(targetId, fingerprint, status, reason), (result) =>
			Message.CompletedTriage({ result }),
		),
})
