import { createEffectCollection } from "@maple/effect-db/electric"
import { DashboardDocument, DashboardId, migrateToLatest } from "@maple/domain/http"
import type { V2DashboardUpdateParams } from "@maple/domain/http/v2"
import { DashboardRowSchema, type DashboardRow } from "@maple/web-data/collections/dashboards"
import { Effect, type ManagedRuntime, Option, Schema } from "effect"
import type { MapleApiV2Client } from "../../platform/api-clients"

// The per-org `dashboards` collection, whose writes
// go through the v2 API and return the Postgres txid TanStack DB awaits on the shape stream.

const decodeDocument = Schema.decodeUnknownOption(DashboardDocument)
const decodeDashboardId = Schema.decodeUnknownEffect(DashboardId)

/** `rowToDashboard`: migrate the stored payload, then decode; an undecodable row is `None`. */
export const rowToDocument = (row: DashboardRow): Option.Option<DashboardDocument> =>
	Option.flatMap(
		Option.liftThrowable((payload: unknown) =>
			migrateToLatest(typeof payload === "string" ? JSON.parse(payload) : payload),
		)(row.payload_json),
		decodeDocument,
	)

/** `rowToUpdateRequest`: the full PATCH body from the row's optimistic payload. */
const toUpdateRequest = (document: DashboardDocument): V2DashboardUpdateParams => ({
	name: document.name,
	description: document.description ?? null,
	tags: document.tags ?? [],
	timeRange: document.timeRange,
	widgets: document.widgets,
	sections: document.sections ?? [],
	variables: document.variables ?? [],
	refreshIntervalSeconds: document.refreshIntervalSeconds ?? null,
})

/** The write landed but carried no txid to confirm it on the shape stream (`requireTxid`). */
export class MissingWriteTxidError extends Schema.TaggedError<MissingWriteTxidError>()(
	"@maple/web/collections/MissingWriteTxidError",
	{ message: Schema.String },
) {}

/** A stored payload that no longer decodes cannot be written back. */
export class UndecodableDashboardError extends Schema.TaggedError<UndecodableDashboardError>()(
	"@maple/web/collections/UndecodableDashboardError",
	{ message: Schema.String, rawId: Schema.String },
) {}

const requireTxid = (txid: string | undefined) =>
	txid === undefined
		? Effect.fail(
				new MissingWriteTxidError({
					message: "Dashboard write succeeded but the server returned no txid",
				}),
			)
		: Effect.succeed(Number(txid))

type V2Client = MapleApiV2Client["Service"]

export const makeDashboardsCollection = (config: {
	readonly orgId: string
	readonly url: string
	readonly runtime: ManagedRuntime.ManagedRuntime<never, never>
	readonly fetchClient: typeof globalThis.fetch
	readonly client: V2Client
}) =>
	createEffectCollection({
		id: `dashboards:${config.orgId}`,
		runtime: config.runtime,
		schema: DashboardRowSchema,
		getKey: (row) => row.id,
		shapeOptions: {
			url: config.url,
			params: { shape: "dashboards", org: config.orgId },
			fetchClient: config.fetchClient,
		},
		onUpdate: ({ transaction }) =>
			Effect.gen(function* () {
				const { modified } = transaction.mutations[0]
				const document = yield* Option.match(rowToDocument(modified), {
					onNone: () =>
						Effect.fail(
							new UndecodableDashboardError({
								message: "This dashboard's saved layout couldn't be read",
								rawId: modified.id,
							}),
						),
					onSome: Effect.succeed,
				})
				const id = yield* decodeDashboardId(modified.id)
				const result = yield* config.client.dashboards.update({
					params: { id },
					payload: toUpdateRequest(document),
				})
				return { txid: yield* requireTxid(result.txid) }
			}),
		onDelete: ({ transaction }) =>
			Effect.gen(function* () {
				const { original } = transaction.mutations[0]
				const id = yield* decodeDashboardId(original.id)
				const result = yield* config.client.dashboards.delete({ params: { id } })
				return { txid: yield* requireTxid(result.txid) }
			}),
	})
