import {
	AlertForbiddenError,
	AlertPersistenceError,
	AlertRuleId as AlertRuleIdSchema,
	AlertValidationError,
	EscalationChainDocument,
	EscalationChainId as EscalationChainIdSchema,
	EscalationChainInUseError,
	EscalationChainNotFoundError,
	EscalationChainsListResponse,
	IsoDateTimeString,
	type AlertDestinationId,
	type AlertRuleId,
	type EscalationChainCreateRequest,
	type EscalationChainId,
	type EscalationChainUpdateRequest,
	type EscalationSteps,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertDestinations, AlertRules, EscalationChains, type EscalationChainRow } from "@maple/db/tables"
import type { MapleDb } from "@maple/db/client"
import { Array as Arr, Context, Effect, Layer, Option, Result, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import * as Policy from "@maple/domain/policy"
import { lockOrgAlertRules, makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"

/** Chains an org may keep; a chain is reusable across rules, so few are needed. */
const MAX_CHAINS_PER_ORG = 100

const decodeChainIdSync = Schema.decodeUnknownSync(EscalationChainIdSchema)
const decodeRuleIdSync = Schema.decodeUnknownSync(AlertRuleIdSchema)
// Only the field read here, leniently: a tier list in an older or newer shape still names its chains.
const decodeTierChainIds = Schema.decodeUnknownOption(
	Schema.Array(Schema.Struct({ escalationChainId: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
)

export interface EscalationChainsServiceApi {
	readonly list: (orgId: OrgId) => Effect.Effect<EscalationChainsListResponse, AlertPersistenceError>
	readonly get: (
		orgId: OrgId,
		chainId: EscalationChainId,
	) => Effect.Effect<EscalationChainDocument, AlertPersistenceError | EscalationChainNotFoundError>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		request: EscalationChainCreateRequest,
	) => Effect.Effect<
		EscalationChainDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError
	>
	readonly update: (
		orgId: OrgId,
		userId: UserId,
		roles: ReadonlyArray<RoleName>,
		chainId: EscalationChainId,
		request: EscalationChainUpdateRequest,
	) => Effect.Effect<
		EscalationChainDocument,
		AlertForbiddenError | AlertValidationError | AlertPersistenceError | EscalationChainNotFoundError
	>
	/** Refused while a rule's tier names the chain; escalations already running finish from their snapshot. */
	readonly delete: (
		orgId: OrgId,
		roles: ReadonlyArray<RoleName>,
		chainId: EscalationChainId,
	) => Effect.Effect<
		void,
		AlertForbiddenError | AlertPersistenceError | EscalationChainNotFoundError | EscalationChainInUseError
	>
}

const validationError = (message: string) => new AlertValidationError({ message, details: [message] })

const decodeIsoSync = Schema.decodeUnknownSync(IsoDateTimeString)
const iso = (ms: number) => decodeIsoSync(new Date(ms).toISOString())

interface RuleRef {
	readonly id: AlertRuleId
	readonly name: string
}

/** Which rules name each chain, from every rule's tier list. */
const ruleRefsByChain = (db: MapleDb, orgId: OrgId) =>
	db
		.run(
			PG.from(AlertRules)
				.select(($) => ({ id: $.id, name: $.name, thresholdsJson: PG.undecoded($.thresholdsJson) }))
				.where(($) => [$.orgId.eq(orgId), $.thresholdsJson.isNotNull()]),
		)
		.pipe(
			Effect.map((rows) => {
				const refs = new Map<string, Array<RuleRef>>()
				Arr.forEach(rows, (row) => {
					const chainIds = Option.match(decodeTierChainIds(row.thresholdsJson), {
						onNone: () => [],
						onSome: (tiers) =>
							Arr.dedupe(
								Arr.filterMap(tiers, (tier) =>
									tier.escalationChainId == null
										? Result.failVoid
										: Result.succeed(tier.escalationChainId),
								),
							),
					})
					Arr.forEach(chainIds, (chainId) => {
						refs.set(chainId, [
							...(refs.get(chainId) ?? []),
							{ id: decodeRuleIdSync(row.id), name: row.name },
						])
					})
				})
				return refs
			}),
		)

const stepDestinationIds = (steps: EscalationSteps): ReadonlyArray<AlertDestinationId> =>
	Arr.dedupe(Arr.flatMap(steps, (step) => Arr.map(step.targets, (target) => target.destinationId)))

const toDocument = (row: EscalationChainRow, refs: ReadonlyArray<RuleRef>) =>
	new EscalationChainDocument({
		id: row.id,
		name: row.name,
		description: row.description,
		steps: row.stepsJson,
		repeatCount: row.repeatCount,
		ruleIds: Arr.map(refs, (ref) => ref.id),
		createdAt: iso(row.createdAt),
		updatedAt: iso(row.updatedAt),
	})

export class EscalationChainsService extends Context.Service<
	EscalationChainsService,
	EscalationChainsServiceApi
>()("@maple/backend/services/alerts/EscalationChainsService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const runtime = yield* AlertRuntime
		const dbExecute = makeDbExecute(database, "EscalationChainsService", makePersistenceError)

		const requireManage = (roles: ReadonlyArray<RoleName>) =>
			Policy.check(
				roles,
				"alerts:manage",
				(denial) =>
					new AlertForbiddenError({
						message: denial.message,
						...(roles.length > 0 ? { roles: [...roles] } : undefined),
					}),
			)

		const findRow = (db: MapleDb, orgId: OrgId, chainId: EscalationChainId) =>
			db
				.run(
					PG.from(EscalationChains)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.id.eq(chainId)])
						.limit(1),
				)
				.pipe(
					Effect.flatMap((rows) =>
						Arr.match(rows, {
							onEmpty: () =>
								Effect.fail(
									new EscalationChainNotFoundError({
										message: "Escalation chain not found",
										chainId,
									}),
								),
							onNonEmpty: ([row]) => Effect.succeed(row),
						}),
					),
				)

		// The org's advisory lock: rule writes and destination deletion take it around their reference checks.
		const lockOrg = lockOrgAlertRules

		const requireDestinations = (db: MapleDb, orgId: OrgId, steps: EscalationSteps) =>
			Effect.gen(function* () {
				const ids = stepDestinationIds(steps)
				const rows = yield* db.run(
					PG.from(AlertDestinations)
						.select("id")
						.where(($) => [$.orgId.eq(orgId), $.id.in_(...ids)]),
				)
				if (rows.length < ids.length) {
					return yield* validationError(
						"An escalation step names a destination that does not exist",
					)
				}
			})

		const list = Effect.fn("EscalationChainsService.list")(function* (orgId: OrgId) {
			const [rows, refs] = yield* dbExecute((db) =>
				Effect.all([
					db.run(
						PG.from(EscalationChains)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["name", "asc"])
							.limit(MAX_CHAINS_PER_ORG),
					),
					ruleRefsByChain(db, orgId),
				]),
			)
			return new EscalationChainsListResponse({
				chains: Arr.map(rows, (row) => toDocument(row, refs.get(row.id) ?? [])),
			})
		})

		const get = Effect.fn("EscalationChainsService.get")(function* (
			orgId: OrgId,
			chainId: EscalationChainId,
		) {
			const [row, refs] = yield* dbExecute((db) =>
				Effect.all([findRow(db, orgId, chainId), ruleRefsByChain(db, orgId)]),
			)
			return toDocument(row, refs.get(row.id) ?? [])
		})

		const create = Effect.fn("EscalationChainsService.create")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			request: EscalationChainCreateRequest,
		) {
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			const id = decodeChainIdSync(runtime.makeUuid())
			const row = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrg(db, orgId)
						const existing = yield* db.run(
							PG.from(EscalationChains)
								.select("id")
								.where(($) => [$.orgId.eq(orgId)])
								.limit(MAX_CHAINS_PER_ORG),
						)
						if (existing.length >= MAX_CHAINS_PER_ORG) {
							return yield* validationError(
								`Organizations may have at most ${MAX_CHAINS_PER_ORG} escalation chains`,
							)
						}
						yield* requireDestinations(db, orgId, request.steps)
						const [inserted] = yield* db.run(
							PG.insertInto(EscalationChains)
								.values({
									id,
									orgId,
									name: request.name,
									description: request.description ?? null,
									stepsJson: request.steps,
									repeatCount: request.repeatCount ?? 0,
									createdAt: nowMs,
									updatedAt: nowMs,
									createdBy: userId,
									updatedBy: userId,
								})
								.returning(),
						)
						return inserted
					}),
				),
			)
			if (row === undefined) {
				return yield* new AlertPersistenceError({ message: "Escalation chain was not created" })
			}
			return toDocument(row, [])
		})

		const update = Effect.fn("EscalationChainsService.update")(function* (
			orgId: OrgId,
			userId: UserId,
			roles: ReadonlyArray<RoleName>,
			chainId: EscalationChainId,
			request: EscalationChainUpdateRequest,
		) {
			yield* requireManage(roles)
			const nowMs = yield* runtime.now
			const [row, refs] = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* lockOrg(db, orgId)
						yield* findRow(db, orgId, chainId)
						if (request.steps !== undefined) yield* requireDestinations(db, orgId, request.steps)
						const [updated] = yield* db.run(
							PG.update(EscalationChains)
								.set({
									...(request.name === undefined ? undefined : { name: request.name }),
									...(request.description === undefined
										? undefined
										: { description: request.description }),
									...(request.steps === undefined
										? undefined
										: { stepsJson: request.steps }),
									...(request.repeatCount === undefined
										? undefined
										: { repeatCount: request.repeatCount }),
									updatedAt: nowMs,
									updatedBy: userId,
								})
								.where(($) => [$.orgId.eq(orgId), $.id.eq(chainId)])
								.returning(),
						)
						if (updated === undefined) {
							return yield* new EscalationChainNotFoundError({
								message: "Escalation chain not found",
								chainId,
							})
						}
						return [updated, yield* ruleRefsByChain(db, orgId)] as const
					}),
				),
			)
			return toDocument(row, refs.get(row.id) ?? [])
		})

		const remove = Effect.fn("EscalationChainsService.delete")(function* (
			orgId: OrgId,
			roles: ReadonlyArray<RoleName>,
			chainId: EscalationChainId,
		) {
			yield* requireManage(roles)
			yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// Rule writes check their chains under this lock, so no rule can commit a reference
						// between this scan and the delete.
						yield* lockOrg(db, orgId)
						yield* findRow(db, orgId, chainId)
						const refs = (yield* ruleRefsByChain(db, orgId)).get(chainId) ?? []
						if (refs.length > 0) {
							return yield* new EscalationChainInUseError({
								message: `Escalation chain is still used by alert rules: ${Arr.join(
									Arr.map(refs, (ref) => ref.name),
									", ",
								)}`,
								chainId,
								ruleIds: Arr.map(refs, (ref) => ref.id),
								ruleNames: Arr.map(refs, (ref) => ref.name),
							})
						}
						yield* db.run(
							PG.deleteFrom(EscalationChains).where(($) => [
								$.orgId.eq(orgId),
								$.id.eq(chainId),
							]),
						)
					}),
				),
			)
		})

		return { list, get, create, update, delete: remove } satisfies EscalationChainsServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)
}
