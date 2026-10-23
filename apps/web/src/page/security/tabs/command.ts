import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readIsAdmin } from "../../alerts/shared/commands"
import { getRun, githubStatus, listFindings, listRuns, listTargets, startRun } from "../kit/api"
import { Message } from "./model"

// Every read and write the three tabs send. Names start with `SecurityApi` so the lab can drop them.

export const ReadSecurityClock = Command.define("ReadSecurityClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const ReadSecurityIsAdmin = Command.define("ReadSecurityIsAdmin", {
	messages: [Message.CompletedReadIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedReadIsAdmin({ isAdmin })),
})

export const FetchTargets = Command.define("SecurityApiListTargets", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchTargets],
	execute: ({ key }) => Effect.map(listTargets, (result) => Message.CompletedFetchTargets({ key, result })),
})

export const FetchRuns = Command.define("SecurityApiListRuns", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchRuns],
	execute: ({ key }) => Effect.map(listRuns(), (result) => Message.CompletedFetchRuns({ key, result })),
})

export const FetchFindings = Command.define("SecurityApiListFindings", {
	args: { key: Schema.String, targetId: SecurityAuditTargetId },
	messages: [Message.CompletedFetchFindings],
	execute: ({ key, targetId }) =>
		Effect.map(listFindings(targetId), (result) =>
			Message.CompletedFetchFindings({ key, targetId, result }),
		),
})

export const FetchLatestRun = Command.define("SecurityApiGetLatestRun", {
	args: { key: Schema.String, runId: SecurityAuditRunId },
	messages: [Message.CompletedFetchLatestRun],
	execute: ({ key, runId }) =>
		Effect.map(getRun(runId), (result) => Message.CompletedFetchLatestRun({ key, runId, result })),
})

export const FetchGithubStatus = Command.define("SecurityApiGithubStatus", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchGithubStatus],
	execute: ({ key }) =>
		Effect.map(githubStatus, (result) => Message.CompletedFetchGithubStatus({ key, result })),
})

export const StartRun = Command.define("SecurityApiStartRun", {
	args: { targetId: SecurityAuditTargetId },
	messages: [Message.CompletedStartRun],
	execute: ({ targetId }) =>
		Effect.map(startRun(targetId), (result) => Message.CompletedStartRun({ targetId, result })),
})
