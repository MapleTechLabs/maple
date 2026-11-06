import { randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Slos, type SloRow } from "@maple/db/tables"
import { SloNotFoundError, SloPersistenceError, SloValidationError } from "@maple/domain/http"
import { type AlertRuleId, type OrgId, SloId, SloWindowDays, type UserId } from "@maple/domain/primitives"
import { SloSli, SloTargetPercent } from "@maple/domain/slo"
import { Array as Arr, Clock, Context, Effect, Layer, Schema, String as Str } from "effect"
import type { MapleDb } from "@maple/db/client"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"

export interface SloRecord {
	readonly id: SloId
	readonly orgId: OrgId
	readonly name: string
	readonly description: string | null
	readonly serviceName: string
	readonly environments: ReadonlyArray<string>
	readonly sli: SloSli
	readonly targetPercent: number
	readonly windowDays: SloWindowDays
	readonly alertRuleId: AlertRuleId | null
	readonly createdAt: number
	readonly updatedAt: number
}

export interface CreateSloInput {
	readonly name: string
	readonly description?: string | null
	readonly serviceName: string
	readonly environments?: ReadonlyArray<string>
	readonly sli: SloSli
	readonly targetPercent: number
	readonly windowDays?: SloWindowDays
	readonly createdBy: UserId
}

export interface UpdateSloInput {
	readonly name?: string
	readonly description?: string | null
	readonly serviceName?: string
	readonly environments?: ReadonlyArray<string>
	readonly sli?: SloSli
	readonly targetPercent?: number
	readonly windowDays?: SloWindowDays
	readonly updatedBy: UserId
}

type SloError = SloNotFoundError | SloValidationError | SloPersistenceError

export interface SlosServiceApi {
	readonly list: (orgId: OrgId) => Effect.Effect<ReadonlyArray<SloRecord>, SloPersistenceError>
	readonly get: (
		orgId: OrgId,
		sloId: SloId,
	) => Effect.Effect<SloRecord, SloNotFoundError | SloPersistenceError>
	readonly create: (
		orgId: OrgId,
		input: CreateSloInput,
	) => Effect.Effect<SloRecord, SloValidationError | SloPersistenceError>
	readonly update: (orgId: OrgId, sloId: SloId, input: UpdateSloInput) => Effect.Effect<SloRecord, SloError>
	readonly delete: (
		orgId: OrgId,
		sloId: SloId,
	) => Effect.Effect<SloId, SloNotFoundError | SloPersistenceError>
}

export const DEFAULT_SLO_WINDOW_DAYS: SloWindowDays = 30

const toPersistenceError = (error: unknown) =>
	new SloPersistenceError({
		message: error instanceof Error ? error.message : "SLO persistence failed",
		cause: error,
	})

const invalid = (message: string) => new SloValidationError({ message })
const notFound = (sloId: SloId) => new SloNotFoundError({ sloId, message: "SLO not found" })

const requireText = (field: string, value: string) => {
	const trimmed = Str.trim(value)
	return trimmed.length === 0 ? Effect.fail(invalid(`${field} is required`)) : Effect.succeed(trimmed)
}

const validateTarget = (value: number) =>
	Schema.decodeEffect(SloTargetPercent)(value).pipe(
		Effect.mapError(() => invalid("target_percent must be between 50 and 99.999")),
	)

const validateWindow = (value: number) =>
	Schema.decodeUnknownEffect(SloWindowDays)(value).pipe(
		Effect.mapError(() => invalid("window_days must be 7, 28 or 30")),
	)

const normalizeEnvironments = (environments: ReadonlyArray<string>) =>
	Arr.dedupe(Arr.filter(Arr.map(environments, Str.trim), Str.isNonEmpty))

const toRecord = (row: Omit<SloRow, "createdBy" | "updatedBy">): SloRecord => ({
	id: row.id,
	orgId: row.orgId,
	name: row.name,
	description: row.description,
	serviceName: row.serviceName,
	environments: row.environmentsJson,
	sli: row.sliJson,
	targetPercent: row.targetPercent,
	windowDays: row.windowDays,
	alertRuleId: row.alertRuleId,
	createdAt: row.createdAt,
	updatedAt: row.updatedAt,
})

const selectSlos = () =>
	PG.from(Slos).select(
		"id",
		"orgId",
		"name",
		"description",
		"serviceName",
		"environmentsJson",
		"sliJson",
		"targetPercent",
		"windowDays",
		"alertRuleId",
		"createdAt",
		"updatedAt",
	)

/** Names are unique per org: the list, incidents and notifications identify an SLO by it. */
const ensureNameFree = Effect.fnUntraced(function* (db: MapleDb, orgId: OrgId, name: string, sloId: SloId) {
	const same = yield* db.run(
		PG.from(Slos)
			.select("id")
			.where(($) => [$.orgId.eq(orgId), $.name.eq(name), $.id.neq(sloId)])
			.limit(1),
	)
	if (same.length > 0) return yield* invalid(`An SLO named '${name}' already exists; pick another name`)
})

export class SlosService extends Context.Service<SlosService, SlosServiceApi>()(
	"@maple/backend/services/slos/SlosService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "SlosService", toPersistenceError)

			const selectOne = (orgId: OrgId, sloId: SloId) =>
				dbExecute((db) =>
					db.run(
						selectSlos()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
							.limit(1),
					),
				).pipe(
					Effect.flatMap((rows) => {
						const row = rows[0]
						return row === undefined
							? Effect.fail(notFound(sloId))
							: Effect.succeed(toRecord(row))
					}),
				)

			const list = Effect.fn("SlosService.list")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						selectSlos()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "desc"], ["id", "desc"]),
					),
				)
				return Arr.map(rows, toRecord)
			})

			const get = Effect.fn("SlosService.get")(function* (orgId: OrgId, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				return yield* selectOne(orgId, sloId)
			})

			const create = Effect.fn("SlosService.create")(function* (orgId: OrgId, input: CreateSloInput) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.sli": input.sli._tag })
				const name = yield* requireText("name", input.name)
				const serviceName = yield* requireText("service_name", input.serviceName)
				const sli = input.sli
				const targetPercent = yield* validateTarget(input.targetPercent)
				const windowDays = yield* validateWindow(input.windowDays ?? DEFAULT_SLO_WINDOW_DAYS)
				const now = yield* Clock.currentTimeMillis
				const id = SloId.make(randomUUID())
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							yield* ensureNameFree(db, orgId, name, id)
							yield* db.run(
								PG.insertInto(Slos).values({
									id,
									orgId,
									name,
									description: input.description ?? null,
									serviceName,
									environmentsJson: normalizeEnvironments(input.environments ?? []),
									sliJson: sli,
									targetPercent,
									windowDays,
									alertRuleId: null,
									createdBy: input.createdBy,
									updatedBy: input.createdBy,
									createdAt: now,
									updatedAt: now,
								}),
							)
						}),
					),
				)
				return yield* selectOne(orgId, id).pipe(
					Effect.catchTag("@maple/http/errors/SloNotFoundError", () =>
						Effect.fail(new SloPersistenceError({ message: "Created SLO not found" })),
					),
				)
			})

			const update = Effect.fn("SlosService.update")(function* (
				orgId: OrgId,
				sloId: SloId,
				input: UpdateSloInput,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				const name = input.name === undefined ? undefined : yield* requireText("name", input.name)
				const serviceName =
					input.serviceName === undefined
						? undefined
						: yield* requireText("service_name", input.serviceName)
				const sli = input.sli
				const targetPercent =
					input.targetPercent === undefined ? undefined : yield* validateTarget(input.targetPercent)
				const windowDays =
					input.windowDays === undefined ? undefined : yield* validateWindow(input.windowDays)
				const now = yield* Clock.currentTimeMillis
				const updated = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							if (name !== undefined) yield* ensureNameFree(db, orgId, name, sloId)
							return yield* db.run(
								PG.update(Slos)
									.set({
										...(name === undefined ? undefined : { name }),
										...(input.description === undefined
											? undefined
											: { description: input.description }),
										...(serviceName === undefined ? undefined : { serviceName }),
										...(input.environments === undefined
											? undefined
											: {
													environmentsJson: normalizeEnvironments(
														input.environments,
													),
												}),
										...(sli === undefined ? undefined : { sliJson: sli }),
										...(targetPercent === undefined ? undefined : { targetPercent }),
										...(windowDays === undefined ? undefined : { windowDays }),
										updatedBy: input.updatedBy,
										updatedAt: now,
									})
									.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
									.returning("id"),
							)
						}),
					),
				)
				if (updated.length === 0) return yield* notFound(sloId)
				return yield* selectOne(orgId, sloId)
			})

			const remove = Effect.fn("SlosService.delete")(function* (orgId: OrgId, sloId: SloId) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.slo.id": sloId })
				const removed = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(Slos)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(sloId)])
							.returning("id"),
					),
				)
				if (removed.length === 0) return yield* notFound(sloId)
				return sloId
			})

			return { list, get, create, update, delete: remove } satisfies SlosServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
