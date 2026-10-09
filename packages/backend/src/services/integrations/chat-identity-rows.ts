/**
 * The chat-identity rows a connector's host Worker touches, as queries over `Database` alone.
 *
 * Apart from a service for the same reason `chat-workspace-rows.ts` is: the Worker that answers a
 * button click reads one row and writes none, so it needs neither an HTTP client nor the connector
 * config a service would acquire. The dashboard's own link flow calls the same functions, so there
 * is one query per question rather than two.
 */
import * as PG from "@maple-dev/effect-orm/postgres"
import { ChatIdentities, type ChatIdentityRow } from "@maple/db/tables"
import {
	ChatConnectorId,
	ChatIdentityId,
	IntegrationsPersistenceError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { Effect, Option } from "effect"
import type { DatabaseApi, DatabaseError } from "@maple/backend/platform/DatabaseLive"

/** One person's chat account, and the Maple user it speaks for. */
export interface ChatIdentityLink {
	readonly id: ChatIdentityId
	readonly userId: UserId
	readonly externalUserId: string
	/** What the platform showed when the link was made. Display only. */
	readonly displayName: string | null
	readonly createdAtMs: number
}

const persistenceError = (error: DatabaseError) =>
	new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })

const unreadable = (message: string) => new IntegrationsPersistenceError({ message })

// The table codecs decode and brand every column, so a stored row is already a link.
const readRow = (row: ChatIdentityRow): ChatIdentityLink => ({
	id: row.id,
	userId: row.userId,
	externalUserId: row.externalUserId,
	displayName: row.displayName,
	createdAtMs: row.createdAt,
})

/**
 * The Maple user a chat account speaks for in this org, or `None` when nobody has linked it.
 *
 * By `(org, connector, external id)` because that is what a click carries: the workspace resolve
 * has already named the org, and the platform's own id for the clicker is on the event.
 */
export const resolveChatIdentity = (
	database: DatabaseApi,
	orgId: OrgId,
	connectorId: ChatConnectorId,
	externalUserId: string,
): Effect.Effect<Option.Option<ChatIdentityLink>, IntegrationsPersistenceError> =>
	Effect.gen(function* () {
		const rows = yield* database
			.execute((db) =>
				db.run(
					PG.from(ChatIdentities)
						.select()
						.where(($) => [
							$.orgId.eq(orgId),
							$.connector.eq(connectorId),
							$.externalUserId.eq(externalUserId),
						])
						.limit(1),
				),
			)
			.pipe(Effect.mapError(persistenceError))
		const row = rows[0]
		return row === undefined ? Option.none() : Option.some(readRow(row))
	})

/** Every link this user holds in this org, across connectors — at most one per connector. */
export const listChatIdentities = (
	database: DatabaseApi,
	orgId: OrgId,
	userId: UserId,
): Effect.Effect<
	ReadonlyArray<ChatIdentityLink & { connector: ChatConnectorId }>,
	IntegrationsPersistenceError
> =>
	Effect.gen(function* () {
		const rows = yield* database
			.execute((db) =>
				db.run(
					PG.from(ChatIdentities)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.userId.eq(userId)]),
				),
			)
			.pipe(Effect.mapError(persistenceError))
		return rows.map((row) => ({ ...readRow(row), connector: row.connector }))
	})

/**
 * Bind a chat account to a Maple user, replacing every binding either of them had.
 *
 * Both directions are replacements, and both matter:
 *
 *   - the person keeps ONE account per connector. Somebody who re-links after losing an account
 *     would otherwise leave the old one still approving as them — authority they cannot see,
 *     because the card and the API both show a single link.
 *   - the account speaks for ONE person per org. Linking an account somebody else had linked
 *     moves it rather than duplicating it.
 *
 * In one transaction because the delete and the insert are two halves of one replacement: between
 * them the person holds no link at all, and a click landing there must not find a stale row.
 */
export const linkChatIdentity = (
	database: DatabaseApi,
	input: {
		readonly id: ChatIdentityId
		readonly orgId: OrgId
		readonly connectorId: ChatConnectorId
		readonly externalUserId: string
		readonly userId: UserId
		readonly displayName?: string | undefined
		readonly nowMs: number
	},
): Effect.Effect<ChatIdentityLink, IntegrationsPersistenceError> =>
	Effect.gen(function* () {
		const rows = yield* database
			.execute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Their previous account on this connector, if any. Deleted rather than left
						// beside the new one (see above).
						yield* db.run(
							PG.deleteFrom(ChatIdentities).where(($) => [
								$.orgId.eq(input.orgId),
								$.connector.eq(input.connectorId),
								$.userId.eq(input.userId),
							]),
						)
						return yield* db.run(
							PG.insertInto(ChatIdentities)
								.values({
									id: input.id,
									orgId: input.orgId,
									connector: input.connectorId,
									externalUserId: input.externalUserId,
									userId: input.userId,
									displayName: input.displayName ?? null,
									createdAt: input.nowMs,
								})
								// The same account, previously linked to somebody else: take it over.
								.onConflictDoUpdate({
									target: ["orgId", "connector", "externalUserId"],
									set: {
										userId: input.userId,
										displayName: input.displayName ?? null,
										createdAt: input.nowMs,
									},
								})
								.returning(),
						)
					}),
				),
			)
			.pipe(Effect.mapError(persistenceError))
		const row = rows[0]
		if (row === undefined) return yield* Effect.fail(unreadable("The chat identity was not stored"))
		return readRow(row)
	})

/** Drop this user's link for this connector, and answer whether there was one. */
export const unlinkChatIdentity = (
	database: DatabaseApi,
	orgId: OrgId,
	connectorId: ChatConnectorId,
	userId: UserId,
): Effect.Effect<boolean, IntegrationsPersistenceError> =>
	Effect.gen(function* () {
		const deleted = yield* database
			.execute((db) =>
				db.run(
					PG.deleteFrom(ChatIdentities)
						.where(($) => [$.orgId.eq(orgId), $.connector.eq(connectorId), $.userId.eq(userId)])
						.returning("id"),
				),
			)
			.pipe(Effect.mapError(persistenceError))
		return deleted.length > 0
	})
