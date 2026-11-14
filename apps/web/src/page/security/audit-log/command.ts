import { readClock } from "@maple/views/data/timing"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { MapleInternalApiClient } from "../../../platform/api-clients"
import { SecurityAuditLogSearch } from "../../../route/search"
import { fetchSessionGrants } from "../../kit/session-grants"
import { Message } from "./model"

// The audit log's reads on the api Worker. Names start with `SecurityApi` (and the clock's and
// session's with `ReadSecurity`) so the lab drops them.

export const PAGE_LIMIT = 50

export const ReadAuditLogClock = readClock("ReadSecurityAuditLogClock", Message.ReadClock)

export const ReadAuditLogGrants = fetchSessionGrants(
	"ReadSecurityAuditLogGrants",
	Message.CompletedReadGrants,
)

const listEvents = (search: SecurityAuditLogSearch, cursor: string | undefined) =>
	Effect.flatMap(MapleInternalApiClient, (api) =>
		api.auditTrail.list({
			query: {
				...(search.provider !== undefined ? { provider: search.provider } : undefined),
				...(search.category !== undefined ? { category: search.category } : undefined),
				...(search.outcome !== undefined ? { outcome: search.outcome } : undefined),
				...(search.actor !== undefined ? { actor: search.actor } : undefined),
				...(cursor !== undefined ? { cursor } : undefined),
				limit: PAGE_LIMIT,
			},
		}),
	)

export const FetchFirstPage = Command.define("SecurityApiAuditLogFirstPage", {
	args: { key: Schema.String, search: SecurityAuditLogSearch },
	messages: [Message.CompletedFetchFirstPage],
	execute: ({ key, search }) =>
		listEvents(search, undefined).pipe(
			settleTo((result) => Message.CompletedFetchFirstPage({ key, result })),
		),
})

export const FetchNextPage = Command.define("SecurityApiAuditLogNextPage", {
	args: {
		key: Schema.String,
		generation: Schema.Number,
		search: SecurityAuditLogSearch,
		cursor: Schema.String,
	},
	messages: [Message.CompletedFetchNextPage],
	execute: ({ key, generation, search, cursor }) =>
		listEvents(search, cursor).pipe(
			settleTo((result) => Message.CompletedFetchNextPage({ key, generation, cursor, result })),
		),
})
