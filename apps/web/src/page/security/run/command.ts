import { SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT } from "@maple/domain/http"
import { SecurityAuditRunId, SecurityAuditTargetId } from "@maple/domain/security-audit"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readIsAdmin } from "../../alerts/shared/commands"
import { parseMarkdownTexts } from "../../kit/markdown"
import {
	cancelRun,
	getRun,
	listFindings,
	listRunEvents,
	listRunUnits,
	listTargets,
	startRun,
} from "../kit/api"
import { Message } from "./model"

// The run page's reads and writes. Names start with `SecurityApi` so the lab can drop them.

export const EVENTS_PAGE = SECURITY_AUDIT_EVENTS_DEFAULT_LIMIT

export const ReadRunClock = Command.define("ReadSecurityRunClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const ReadRunIsAdmin = Command.define("ReadSecurityRunIsAdmin", {
	messages: [Message.CompletedReadIsAdmin],
	execute: Effect.map(readIsAdmin, (isAdmin) => Message.CompletedReadIsAdmin({ isAdmin })),
})

export const FetchRun = Command.define("SecurityApiGetRun", {
	args: { key: Schema.String, runId: SecurityAuditRunId },
	messages: [Message.CompletedFetchRun],
	execute: ({ key, runId }) =>
		Effect.map(getRun(runId), (result) => Message.CompletedFetchRun({ key, result })),
})

export const FetchEvents = Command.define("SecurityApiListRunEvents", {
	args: { key: Schema.String, runId: SecurityAuditRunId },
	messages: [Message.CompletedFetchEvents],
	execute: ({ key, runId }) =>
		Effect.map(listRunEvents(runId, { limit: EVENTS_PAGE }), (result) =>
			Message.CompletedFetchEvents({ key, result }),
		),
})

export const FetchOlderEvents = Command.define("SecurityApiListOlderRunEvents", {
	args: { runId: SecurityAuditRunId, beforeAt: Schema.Finite, beforeId: Schema.String },
	messages: [Message.CompletedFetchOlderEvents],
	execute: ({ runId, beforeAt, beforeId }) =>
		Effect.map(listRunEvents(runId, { limit: EVENTS_PAGE, beforeAt, beforeId }), (result) =>
			Message.CompletedFetchOlderEvents({ result }),
		),
})

export const FetchUnits = Command.define("SecurityApiListRunUnits", {
	args: { key: Schema.String, runId: SecurityAuditRunId },
	messages: [Message.CompletedFetchUnits],
	execute: ({ key, runId }) =>
		Effect.map(listRunUnits(runId), (result) => Message.CompletedFetchUnits({ key, result })),
})

export const FetchRunTargets = Command.define("SecurityApiListRunTargets", {
	args: { key: Schema.String },
	messages: [Message.CompletedFetchTargets],
	execute: ({ key }) => Effect.map(listTargets, (result) => Message.CompletedFetchTargets({ key, result })),
})

export const FetchRunFindings = Command.define("SecurityApiListRunFindings", {
	args: { key: Schema.String, targetId: SecurityAuditTargetId },
	messages: [Message.CompletedFetchFindings],
	execute: ({ key, targetId }) =>
		Effect.map(listFindings(targetId), (result) => Message.CompletedFetchFindings({ key, result })),
})

export const StartAnotherRun = Command.define("SecurityApiStartAnotherRun", {
	args: { targetId: SecurityAuditTargetId, budget: Schema.NullOr(Schema.Finite) },
	messages: [Message.CompletedStartRun],
	execute: ({ targetId, budget }) =>
		Effect.map(startRun(targetId, budget === null ? {} : { budget }), (result) =>
			Message.CompletedStartRun({ result }),
		),
})

export const CancelRun = Command.define("SecurityApiCancelRun", {
	args: { runId: SecurityAuditRunId },
	messages: [Message.CompletedCancel],
	execute: ({ runId }) => Effect.map(cancelRun(runId), (result) => Message.CompletedCancel({ result })),
})

/** The three reports through the chat's markdown parse; a text it rejects stays plain text. */
export const ParseSecurityReports = Command.define("ParseSecurityReports", {
	args: { texts: Schema.Array(Schema.String) },
	messages: [Message.CompletedParseReports],
	execute: ({ texts }) =>
		Effect.map(parseMarkdownTexts(texts), (parsed) => Message.CompletedParseReports({ parsed })),
})
