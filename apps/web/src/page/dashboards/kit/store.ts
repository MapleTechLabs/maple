import { type DashboardDocument, IsoDateTimeString } from "@maple/domain/http"
import { Clock, Effect, Option, Schema } from "effect"
import { OrgCollections } from "../../../data/collections/org-collections"
import { rowToDocument } from "../../../data/collections/dashboards"
import { PageOutMessage } from "../../contract"

// The dashboard mutations over the org collection:
// writes go through the collection's optimistic update, so live queries show them at once.

/** `getErrorMessage`'s fallback when no failure in the chain carries a message. */
export const PERSISTENCE_UNAVAILABLE = "Dashboard persistence is temporarily unavailable"

/** A document's fields as a plain object: what an updater spreads and returns. */
export type DocumentFields = { readonly [K in keyof DashboardDocument]: DashboardDocument[K] }

/** The dashboard is not in the collection, or its payload does not decode. */
export class DashboardUnreadableError extends Schema.TaggedError<DashboardUnreadableError>()(
	"@maple/web/dashboards/DashboardUnreadableError",
	{ message: Schema.String, rawId: Schema.String },
) {}

/** A rejected write, with the cause the collection or API reported. */
export class DashboardWriteError extends Schema.TaggedError<DashboardWriteError>()(
	"@maple/web/dashboards/DashboardWriteError",
	{ message: Schema.String, cause: Schema.Defect() },
) {}

const messageField = (value: unknown): Option.Option<string> =>
	typeof value === "object" && value !== null && "message" in value && typeof value.message === "string"
		? Option.some(value.message).pipe(Option.filter((message) => message.trim().length > 0))
		: Option.none()

/** The wrapped failure an error carries, if any. */
const causeOf = (value: unknown): Option.Option<object> =>
	typeof value === "object" && value !== null && "cause" in value && typeof value.cause === "object"
		? Option.fromNullishOr(value.cause)
		: Option.none()

/** `messageFromErrorChain`: the most specific message down the `cause` chain. */
export const errorMessageOf = (error: unknown, depth = 0): string => {
	if (depth > 5) return PERSISTENCE_UNAVAILABLE
	const nested = Option.map(causeOf(error), (inner) => errorMessageOf(inner, depth + 1))
	return Option.getOrElse(
		Option.orElse(
			Option.filter(nested, (message) => message !== PERSISTENCE_UNAVAILABLE),
			() => messageField(error),
		),
		() => PERSISTENCE_UNAVAILABLE,
	)
}

/** The org's dashboards collection. */
export const dashboardsOf = (orgId: string) =>
	Effect.gen(function* () {
		const collections = yield* OrgCollections
		const set = yield* collections.forOrg(orgId)
		return set.dashboards
	})

/** `readDashboard`: the decoded document the collection holds (optimistic state included). */
export const readDocument = (orgId: string, id: string) =>
	Effect.flatMap(dashboardsOf(orgId), (collection) =>
		Option.match(Option.flatMap(Option.fromNullishOr(collection.get(id)), rowToDocument), {
			onNone: () =>
				Effect.fail(
					new DashboardUnreadableError({
						message: "This dashboard hasn’t finished loading. Try again in a moment",
						rawId: id,
					}),
				),
			onSome: Effect.succeed,
		}),
	)

/** `isTxidAwaitTimeout`: the write reached the server, only this tab's sync-back timed out. */
const isTxidAwaitTimeout = (error: unknown, depth = 0): boolean => {
	if (depth > 5 || typeof error !== "object" || error === null) return false
	if ("name" in error && error.name === "TimeoutWaitingForTxIdError") return true
	if (Option.exists(messageField(error), (message) => message.includes("Timeout waiting for txId")))
		return true
	return Option.exists(causeOf(error), (inner) => isTxidAwaitTimeout(inner, depth + 1))
}

/** How a write settled: synced back, or saved while this tab's live sync did not catch up. */
export const WriteSync = Schema.Literals(["Synced", "Behind"])
export type WriteSync = typeof WriteSync.Type

/**
 * The toast `applyMutationError` raises for a txid timeout: the edit reached the server, but the
 * optimistic copy rolled back. "Reconnect" is the root's `retryOrgCollections`.
 */
export const behindToast = () =>
	PageOutMessage.RequestedToast({
		type: "warning",
		title: "Saved, but this tab is behind",
		description:
			"The change reached the server; this tab’s live sync didn’t catch up, so it isn’t shown yet.",
		timeoutMs: 10000,
		action: null,
		rootAction: { label: "Reconnect", action: { _tag: "ReconnectOrgCollections" } },
	})

/** A transaction's settlement as an Effect; a rejection keeps its cause for the message. */
const settled = <A>(promise: () => Promise<A>): Effect.Effect<WriteSync, DashboardWriteError> =>
	Effect.tryPromise({
		try: promise,
		catch: (cause) => new DashboardWriteError({ message: errorMessageOf(cause), cause }),
	}).pipe(
		Effect.as<WriteSync>("Synced"),
		Effect.catchIf(
			(error) => isTxidAwaitTimeout(error.cause),
			() => Effect.succeed<WriteSync>("Behind"),
		),
	)

/**
 * `mutateDashboard`: apply `updater` to the current document and write it through the collection.
 * The document is JSON round-tripped first so no present-`undefined` key reaches the PATCH encode.
 */
export const mutateDashboard = (
	orgId: string,
	id: string,
	updater: (document: DashboardDocument, nowIso: IsoDateTimeString) => DocumentFields,
) =>
	Effect.gen(function* () {
		const collection = yield* dashboardsOf(orgId)
		const current = yield* readDocument(orgId, id)
		// The updaters' `updatedAt` timestamp.
		const nowIso = IsoDateTimeString.make(new Date(yield* Clock.currentTimeMillis).toISOString())
		const updated = updater(current, nowIso)
		if (updated === current) return "Synced" satisfies WriteSync
		const plain: unknown = JSON.parse(JSON.stringify(updated))
		const transaction = collection.update(id, (draft) => {
			draft.payload_json = plain
			draft.name = updated.name
			draft.updated_at = updated.updatedAt
		})
		return yield* settled(() => transaction.isPersisted.promise)
	})

/** `deleteDashboard`: the collection's optimistic delete. */
export const deleteDashboard = (orgId: string, id: string) =>
	Effect.gen(function* () {
		const collection = yield* dashboardsOf(orgId)
		if (collection.get(id) === undefined) return "Synced" satisfies WriteSync
		const transaction = collection.delete(id)
		return yield* settled(() => transaction.isPersisted.promise)
	})

/** `collection.utils.awaitTxId(txid).catch(() => undefined)` after a create. */
export const awaitTxid = (orgId: string, txid: string | undefined) =>
	txid === undefined
		? Effect.void
		: Effect.flatMap(dashboardsOf(orgId), (collection) =>
				Effect.ignore(Effect.tryPromise(() => collection.utils.awaitTxId(Number(txid)))),
			)
