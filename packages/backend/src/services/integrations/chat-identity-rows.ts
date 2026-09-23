/**
 * The chat-identity rows a connector's host Worker touches, as queries over `Database` alone.
 *
 * Apart from a service for the same reason `chat-workspace-rows.ts` is: the Worker that answers a
 * button click reads one row and writes none, so it needs neither an HTTP client nor the connector
 * config a service would acquire. The dashboard's own link flow calls the same functions, so there
 * is one query per question rather than two.
 */
import { chatIdentities } from "@maple/db"
import {
	ChatConnectorId,
	ChatIdentityId,
	IntegrationsPersistenceError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { and, eq } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { DatabaseApi, DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { dateToMs, msToDate } from "@maple/backend/platform/time"

/** One person's chat account, and the Maple user it speaks for. */
export interface ChatIdentityLink {
	readonly id: ChatIdentityId
	readonly userId: UserId
	readonly externalUserId: string
	/** What the platform showed when the link was made. Display only. */
	readonly displayName: string | null
	readonly createdAtMs: number
}

const decodeStored = Schema.decodeUnknownEffect(
	Schema.Struct({ id: ChatIdentityId, userId: UserId, externalUserId: Schema.String }),
)

const persistenceError = (error: DatabaseError) =>
	new IntegrationsPersistenceError({ message: `${error._tag}: ${error.message}` })

const unreadable = (message: string) => new IntegrationsPersistenceError({ message })

const readRow = (row: {
	id: string
	userId: string
	externalUserId: string
	displayName: string | null
	createdAt: Date
}) =>
	decodeStored(row).pipe(
		Effect.map(
			(stored): ChatIdentityLink => ({
				id: stored.id,
				userId: stored.userId,
				externalUserId: stored.externalUserId,
				displayName: row.displayName,
				createdAtMs: dateToMs(row.createdAt),
			}),
		),
		Effect.mapError((error) => unreadable(`Stored chat identity is unreadable: ${error.message}`)),
	)

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
				db
					.select()
					.from(chatIdentities)
					.where(
						and(
							eq(chatIdentities.orgId, orgId),
							eq(chatIdentities.connector, connectorId),
							eq(chatIdentities.externalUserId, externalUserId),
						),
					)
					.limit(1),
			)
			.pipe(Effect.mapError(persistenceError))
		const row = rows[0]
		return row === undefined ? Option.none() : Option.some(yield* readRow(row))
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
				db
					.select()
					.from(chatIdentities)
					.where(and(eq(chatIdentities.orgId, orgId), eq(chatIdentities.userId, userId))),
			)
			.pipe(Effect.mapError(persistenceError))
		return yield* Effect.forEach(rows, (row) =>
			Effect.map(readRow(row), (link) => ({ ...link, connector: row.connector })),
		)
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
				db.transaction((tx) =>
					Effect.gen(function* () {
						// Their previous account on this connector, if any. Deleted rather than left
						// beside the new one — see above.
						yield* tx
							.delete(chatIdentities)
							.where(
								and(
									eq(chatIdentities.orgId, input.orgId),
									eq(chatIdentities.connector, input.connectorId),
									eq(chatIdentities.userId, input.userId),
								),
							)
						return yield* tx
							.insert(chatIdentities)
							.values({
								id: input.id,
								orgId: input.orgId,
								connector: input.connectorId,
								externalUserId: input.externalUserId,
								userId: input.userId,
								displayName: input.displayName ?? null,
								createdAt: msToDate(input.nowMs),
							})
							// The same account, previously linked to somebody else: take it over.
							.onConflictDoUpdate({
								target: [
									chatIdentities.orgId,
									chatIdentities.connector,
									chatIdentities.externalUserId,
								],
								set: {
									userId: input.userId,
									displayName: input.displayName ?? null,
									createdAt: msToDate(input.nowMs),
								},
							})
							.returning()
					}),
				),
			)
			.pipe(Effect.mapError(persistenceError))
		const row = rows[0]
		if (row === undefined) return yield* Effect.fail(unreadable("The chat identity was not stored"))
		return yield* readRow(row)
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
				db
					.delete(chatIdentities)
					.where(
						and(
							eq(chatIdentities.orgId, orgId),
							eq(chatIdentities.connector, connectorId),
							eq(chatIdentities.userId, userId),
						),
					)
					.returning({ id: chatIdentities.id }),
			)
			.pipe(Effect.mapError(persistenceError))
		return deleted.length > 0
	})
