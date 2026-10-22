import { randomBytes, randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { hashIngestKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import { AwsConnections, type AwsConnectionRow, Sources } from "@maple/db/tables"
import {
	AWS_MODULE_SPECS,
	AWS_ROLE_TAGS,
	AWS_TEMPLATE_VERSION,
	awsConnectionResourceNames,
	awsModuleOfPolicyName,
	awsOidcIssuer,
	awsOidcSubject,
	awsRoleArn,
	type AwsMetricStream,
	awsSetupPlan,
	isAwsModuleAvailable,
} from "@maple/domain/aws"
import {
	AwsAccountAlreadyConnectedError,
	AwsIntegrationUnavailableError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsValidationError,
} from "@maple/domain/http"
import {
	AWS_MODULES,
	type AwsAccountId,
	AwsConnectionId,
	type AwsModule,
	type OrgId,
	type UserId,
} from "@maple/domain/primitives"
import { Cause, Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import {
	createIntegrationSource,
	deleteSourcesOf,
	integrationSourceName,
	type PollOutcome,
	reportPoll,
} from "@maple/backend/services/org/integration-sources"
import { AwsApiError, checkRole } from "./aws/api"
import { type AwsOidcSigner, makeAwsOidcSigner } from "./aws/oidc"
import { renderAwsCleanupScript, renderAwsSetup } from "./aws/setup"

export interface AwsConnection {
	readonly id: AwsConnectionId
	readonly accountId: AwsAccountId
	readonly roleArn: string
	/** The issuer and subject the role's trust policy names: what Maple's tokens carry. */
	readonly oidcIssuer: string
	readonly oidcSubject: string
	readonly modules: ReadonlyArray<AwsModule>
	/** What the latest check found on the role. Null until a check could assume it. */
	readonly grantedModules: ReadonlyArray<AwsModule> | null
	readonly templateVersion: number | null
	/** The deployed setup differs from what the connection asks for. */
	readonly setupOutdated: boolean
	readonly verifiedAt: number | null
	readonly lastCheckedAt: number | null
	readonly lastCheckError: string | null
	/** Null: no metric stream asked for. */
	readonly metricStream: AwsMetricStream | null
	/** The last metric delivery the receiver accepted, and why the last one failed. */
	readonly metricsLastReceivedAt: number | null
	readonly metricsLastError: string | null
	readonly createdAt: number
}

export interface AwsModuleInfo {
	readonly module: AwsModule
	readonly title: string
	readonly summary: string
	readonly available: boolean
}

export interface AwsSetup {
	readonly stackName: string
	readonly stackRegion: string
	readonly setupScript: string
	readonly cleanupScript: string
	readonly cloudformationTemplate: string
	readonly terraform: string
	/** The metric stream's stack, deployed to each of its regions. Null without a stream. */
	readonly metricsStackName: string | null
	readonly metricsCloudformationTemplate: string | null
}

export interface AwsCheckSweep {
	readonly due: number
	readonly checked: number
	readonly failures: number
}

type ModulesError = IntegrationsValidationError

export interface AwsConnectionServiceApi {
	readonly status: (orgId: OrgId) => Effect.Effect<
		{
			/** False when this deployment has no OIDC signing key to assume roles with. */
			readonly available: boolean
			readonly modules: ReadonlyArray<AwsModuleInfo>
			readonly connections: ReadonlyArray<AwsConnection>
		},
		IntegrationsPersistenceError
	>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		input: {
			readonly accountId: AwsAccountId
			readonly modules: ReadonlyArray<AwsModule>
			/** Omitted: no metric stream. */
			readonly metricStream?: AwsMetricStream | null | undefined
		},
	) => Effect.Effect<
		AwsConnection,
		| AwsAccountAlreadyConnectedError
		| AwsIntegrationUnavailableError
		| ModulesError
		| IntegrationsPersistenceError
	>
	/** AWS only follows once the stack is deployed again. */
	readonly update: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
		patch: {
			readonly modules?: ReadonlyArray<AwsModule> | undefined
			/** Null turns the stream off; undefined leaves it. */
			readonly metricStream?: AwsMetricStream | null | undefined
		},
	) => Effect.Effect<AwsConnection, IntegrationsNotFoundError | ModulesError | IntegrationsPersistenceError>
	readonly setup: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
	) => Effect.Effect<
		AwsSetup,
		IntegrationsNotFoundError | AwsIntegrationUnavailableError | IntegrationsPersistenceError
	>
	/** Assumes the role now. A failed check is recorded on the connection, not failed with. */
	readonly check: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
	) => Effect.Effect<
		AwsConnection,
		IntegrationsNotFoundError | AwsIntegrationUnavailableError | IntegrationsPersistenceError
	>
	/** The hourly sweep: every connection not checked within the hour, except paused ones. */
	readonly checkDue: () => Effect.Effect<AwsCheckSweep, IntegrationsPersistenceError>
	/** Deleting the row is the disconnect: Maple stops assuming the role. */
	readonly delete: (
		orgId: OrgId,
		connectionId: AwsConnectionId,
	) => Effect.Effect<
		{ readonly connection: AwsConnection; readonly cleanupScript: string },
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"AWS connection database error",
)

const notFound = () => new IntegrationsNotFoundError({ message: "No such AWS connection." })

const unavailable = () =>
	new AwsIntegrationUnavailableError({ message: "AWS cannot be connected on this Maple deployment." })

/** A sweep checks a connection once its last check is this old. */
const CHECK_INTERVAL_MS = 55 * 60_000
/** A claimed batch holds its rows for the lane's whole deadline; a stalled sweep's rest is retried. */
const CHECK_LEASE_MS = 15 * 60_000
/** A manual check this soon after a good one answers with it. */
const MANUAL_CHECK_INTERVAL_MS = 5_000
/** Connections one batch claims; a sweep runs batches until none is full. */
const SWEEP_LIMIT = 100
/** A sweep starts no batch past this, inside the lane's 15 minute deadline. */
const SWEEP_BUDGET_MS = 10 * 60_000
/**
 * A Worker allows six simultaneous connections, shared by the lane's Postgres pool and the AWS
 * fetches; each check holds one of each at most.
 */
const SWEEP_CONCURRENCY = 2

const sameModules = (a: ReadonlyArray<AwsModule>, b: ReadonlyArray<AwsModule>) =>
	a.length === b.length && a.every((module) => b.includes(module))

/** Modules in their canonical order, without repeats. */
const normalizeModules = (modules: ReadonlyArray<AwsModule>) =>
	AWS_MODULES.filter((module) => modules.includes(module))

const toConnection = (issuer: string, row: AwsConnectionRow): AwsConnection => {
	const names = awsConnectionResourceNames(row.id)
	return {
		id: row.id,
		accountId: row.accountId,
		roleArn: awsRoleArn(row.accountId, names.roleName),
		oidcIssuer: issuer,
		oidcSubject: awsOidcSubject(row.id),
		modules: row.modules,
		grantedModules: row.grantedModules,
		templateVersion: row.templateVersion,
		setupOutdated:
			row.grantedModules !== null &&
			(row.templateVersion !== AWS_TEMPLATE_VERSION || !sameModules(row.modules, row.grantedModules)),
		verifiedAt: row.verifiedAt,
		lastCheckedAt: row.lastCheckedAt,
		lastCheckError: row.lastCheckError,
		metricStream: row.metricStream,
		metricsLastReceivedAt: row.streamLastReceivedAt,
		metricsLastError: row.streamLastError,
		createdAt: row.createdAt,
	}
}

// Binds the ciphertext to its row, so a stored secret cannot be moved onto another connection.
const streamSecretAad = (connectionId: string) =>
	Buffer.from(`aws_connections:stream:v1:${connectionId}`, "utf8")

const MODULE_INFO: ReadonlyArray<AwsModuleInfo> = AWS_MODULES.map((module) => ({
	module,
	title: AWS_MODULE_SPECS[module].title,
	summary: AWS_MODULE_SPECS[module].summary,
	available: isAwsModuleAvailable(module),
}))

const validateModules = (
	modules: ReadonlyArray<AwsModule>,
): Effect.Effect<ReadonlyArray<AwsModule>, ModulesError> => {
	const planned = modules.filter((module) => !isAwsModuleAvailable(module))
	return planned.length === 0
		? Effect.succeed(normalizeModules(modules))
		: Effect.fail(
				new IntegrationsValidationError({
					message: `Maple does not read ${planned.join(", ")} from AWS yet.`,
				}),
			)
}

interface CheckResult {
	readonly changes: Partial<AwsConnectionRow>
	/** Null: nothing to report on the source, the setup is still being done. */
	readonly outcome: PollOutcome | null
}

/** What one check means for the row and its source. */
export const interpretCheck = (
	row: AwsConnectionRow,
	result:
		| {
				readonly _tag: "Ok"
				readonly tags: ReadonlyArray<{ readonly key: string; readonly value: string }>
				readonly attachedPolicyNames: ReadonlyArray<string>
		  }
		| { readonly _tag: "Failed"; readonly error: AwsApiError },
	now: number,
): CheckResult => {
	const roleName = awsConnectionResourceNames(row.id).roleName
	if (result._tag === "Ok") {
		const version = Number(result.tags.find((tag) => tag.key === AWS_ROLE_TAGS.templateVersion)?.value)
		const granted = normalizeModules(
			result.attachedPolicyNames.flatMap((name) => {
				const module = awsModuleOfPolicyName(roleName, name)
				return module === undefined ? [] : [module]
			}),
		)
		const missing = row.modules.filter((module) => !granted.includes(module))
		const error =
			missing.length === 0
				? null
				: `The role does not grant ${missing.join(", ")} yet: run the setup script again.`
		return {
			changes: {
				verifiedAt: row.verifiedAt ?? now,
				lastCheckedAt: now,
				lastCheckError: error,
				grantedModules: granted,
				templateVersion: Number.isInteger(version) ? version : null,
			},
			outcome: error === null ? { _tag: "Ok" } : { _tag: "Failed", error },
		}
	}
	const { error } = result
	const base = { lastCheckedAt: now }
	switch (error.kind) {
		case "assume_denied": {
			// Before the first success the setup is still being done: the source stays pending.
			if (row.verifiedAt === null) {
				return {
					changes: {
						...base,
						lastCheckError:
							"Maple cannot assume the role yet. Run the setup script in AWS CloudShell, signed in to this account.",
					},
					outcome: null,
				}
			}
			const reason =
				"Maple can no longer assume the role: its stack was deleted or its trust policy changed. Run the setup script again."
			return { changes: { ...base, lastCheckError: reason }, outcome: { _tag: "Disconnected", reason } }
		}
		case "read_denied": {
			const message =
				"Maple assumed the role but it cannot read its own policies. Run the setup script again to repair it."
			return {
				changes: { ...base, lastCheckError: message },
				outcome: row.verifiedAt === null ? null : { _tag: "Failed", error: message },
			}
		}
		case "maple_identity": {
			const message =
				"AWS could not verify Maple's identity token. This is on Maple's side; nothing to change in AWS."
			return {
				changes: { ...base, lastCheckError: message },
				outcome: row.verifiedAt === null ? null : { _tag: "Failed", error: message },
			}
		}
		// AWS itself, not the setup: the source keeps its last report, and goes stale if it lasts.
		case "throttled":
		case "upstream":
			return { changes: { ...base, lastCheckError: error.message }, outcome: null }
	}
}

export class AwsConnectionService extends Context.Service<AwsConnectionService, AwsConnectionServiceApi>()(
	"@maple/backend/services/AwsConnectionService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const httpClient = yield* HttpClient.HttpClient
			const dbExecute = makeDbExecute(database, "AwsConnectionService", toPersistenceError)
			const persistence = (message: string) => new IntegrationsPersistenceError({ message })
			const encryptionKey = yield* parseBase64Aes256GcmKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
				persistence,
			)
			// The ingest gateway hashes a delivery's access key with this and looks the row up by it.
			const lookupHmacKey = yield* parseIngestKeyLookupHmacKey(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
				persistence,
			)
			const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")

			/** A new stream secret as the four columns that hold it. */
			const mintStreamSecret = (connectionId: AwsConnectionId) =>
				Effect.gen(function* () {
					const secret = `maple_aws_${randomBytes(24).toString("base64url")}`
					const encrypted = yield* encryptAes256Gcm(
						secret,
						encryptionKey,
						persistence,
						streamSecretAad(connectionId),
					)
					return {
						streamSecretCiphertext: encrypted.ciphertext,
						streamSecretIv: encrypted.iv,
						streamSecretTag: encrypted.tag,
						streamSecretHash: hashIngestKey(secret, lookupHmacKey),
					}
				})

			const issuer = awsOidcIssuer(env.MAPLE_API_BASE_URL)
			// Without a usable key nothing can be assumed, so no setup is handed out either.
			const signer: AwsOidcSigner | undefined = yield* Option.match(env.MAPLE_AWS_OIDC_SIGNING_KEY, {
				onNone: () => Effect.succeed(undefined),
				onSome: (key) =>
					makeAwsOidcSigner(issuer, key).pipe(
						Effect.catchTag("@maple/backend/integrations/AwsOidcKeyError", (error) =>
							Effect.logWarning(`AWS integration disabled: ${error.message}`).pipe(
								Effect.as(undefined),
							),
						),
					),
			})
			const connectionOf = (row: AwsConnectionRow) => toConnection(issuer, row)

			const selectRow = (orgId: OrgId, connectionId: AwsConnectionId) =>
				dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(connectionId)])
							.limit(1),
					),
				).pipe(
					Effect.flatMap(([row]) =>
						row === undefined ? Effect.fail(notFound()) : Effect.succeed(row),
					),
				)

			const status = Effect.fn("AwsConnectionService.status")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "asc"], ["id", "asc"]),
					),
				)
				return {
					available: signer !== undefined,
					modules: MODULE_INFO,
					connections: rows.map(connectionOf),
				}
			})

			const create = Effect.fn("AwsConnectionService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				input: {
					readonly accountId: AwsAccountId
					readonly modules: ReadonlyArray<AwsModule>
					readonly metricStream?: AwsMetricStream | null | undefined
				},
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.aws.account_id": input.accountId })
				if (signer === undefined) return yield* unavailable()
				const modules = yield* validateModules(input.modules)
				const id = AwsConnectionId.make(randomUUID())
				const streamSecret = yield* mintStreamSecret(id)
				const now = yield* Clock.currentTimeMillis
				// The connection and the source it sends as land together.
				const [row] = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const sourceId = yield* createIntegrationSource(
								db,
								orgId,
								{ platform: "aws", name: integrationSourceName.aws(input) },
								now,
							)
							const inserted = yield* db.run(
								PG.insertInto(AwsConnections)
									.values({
										id,
										orgId,
										sourceId,
										accountId: input.accountId,
										modules,
										metricStream: input.metricStream ?? null,
										...streamSecret,
										createdBy: userId,
										createdAt: now,
										updatedAt: now,
									})
									.onConflictDoNothing({ target: ["orgId", "accountId"] })
									.returning(),
							)
							// An account that is already connected keeps no source of its own.
							if (inserted.length === 0) yield* deleteSourcesOf(db, orgId, [{ sourceId }])
							return inserted
						}),
					),
				)
				if (row === undefined) {
					return yield* new AwsAccountAlreadyConnectedError({
						accountId: input.accountId,
						message: `The AWS account ${input.accountId} is already connected.`,
					})
				}
				return connectionOf(row)
			})

			const update = Effect.fn("AwsConnectionService.update")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
				patch: {
					readonly modules?: ReadonlyArray<AwsModule> | undefined
					readonly metricStream?: AwsMetricStream | null | undefined
				},
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.aws.connection_id": connectionId })
				const modules =
					patch.modules === undefined ? undefined : yield* validateModules(patch.modules)
				const changes = {
					...(modules !== undefined && { modules }),
					...(patch.metricStream !== undefined && { metricStream: patch.metricStream }),
					// A stream turned off stops authenticating at once, though its Firehose may still be
					// deployed; turning it back on mints a new secret for the next setup.
					...(patch.metricStream === null && {
						streamSecretCiphertext: null,
						streamSecretIv: null,
						streamSecretTag: null,
						streamSecretHash: null,
					}),
				}
				if (Object.keys(changes).length === 0)
					return connectionOf(yield* selectRow(orgId, connectionId))
				const updatedAt = yield* Clock.currentTimeMillis
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.update(AwsConnections)
							.set({ ...changes, updatedAt })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(connectionId)])
							.returning(),
					),
				)
				if (row === undefined) return yield* notFound()
				return connectionOf(row)
			})

			/** Mints a stream secret for a connection made before streams. */
			const withStreamSecret = (row: AwsConnectionRow) =>
				Effect.gen(function* () {
					const minted = yield* mintStreamSecret(row.id)
					// A concurrent setup may mint first: whichever secret landed is the one to use.
					const [updated] = yield* dbExecute((db) =>
						db.run(
							PG.update(AwsConnections)
								.set(minted)
								.where(($) => [$.id.eq(row.id), $.streamSecretHash.isNull()])
								.returning(),
						),
					)
					return updated ?? (yield* selectRow(row.orgId, row.id))
				})

			/** The plaintext stream secret the account's Firehose sends. */
			const streamAccessKey = (row: AwsConnectionRow) =>
				Effect.gen(function* () {
					const held = row.streamSecretHash === null ? yield* withStreamSecret(row) : row
					const { streamSecretCiphertext, streamSecretIv, streamSecretTag } = held
					if (
						streamSecretCiphertext === null ||
						streamSecretIv === null ||
						streamSecretTag === null
					) {
						return yield* persistence("The AWS connection has no stream secret")
					}
					return yield* decryptAes256Gcm(
						{ ciphertext: streamSecretCiphertext, iv: streamSecretIv, tag: streamSecretTag },
						encryptionKey,
						() => persistence("Failed to decrypt the AWS stream secret"),
						streamSecretAad(row.id),
					)
				})

			const setup = Effect.fn("AwsConnectionService.setup")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.aws.connection_id": connectionId })
				if (signer === undefined) return yield* unavailable()
				const row = yield* selectRow(orgId, connectionId)
				const plan = awsSetupPlan({
					connectionId: row.id,
					accountId: row.accountId,
					issuer,
					modules: row.modules,
				})
				const stream =
					row.metricStream === null
						? null
						: {
								...row.metricStream,
								endpoint: `${ingestBaseUrl}/v1/firehose/aws/${row.id}`,
								accessKey: yield* streamAccessKey(row),
							}
				return yield* renderAwsSetup(row.id, row.accountId, plan, stream)
			})

			/** Assumes the row's role and writes what it found, on the row and on its source. */
			const runCheck = (signer: AwsOidcSigner, row: AwsConnectionRow) =>
				Effect.gen(function* () {
					const names = awsConnectionResourceNames(row.id)
					const result = yield* Clock.currentTimeMillis.pipe(
						Effect.flatMap((issuedAt) => signer.mint(awsOidcSubject(row.id), issuedAt)),
						Effect.mapError(
							(error) => new AwsApiError({ message: error.message, kind: "maple_identity" }),
						),
						Effect.flatMap((token) =>
							checkRole(httpClient, Redacted.make(token), {
								roleArn: awsRoleArn(row.accountId, names.roleName),
								roleName: names.roleName,
								sessionName: names.sessionName,
							}),
						),
						Effect.map((report) => ({ _tag: "Ok" as const, ...report })),
						Effect.catchTag("@maple/backend/integrations/AwsApiError", (error) =>
							Effect.succeed({ _tag: "Failed" as const, error }),
						),
					)
					const now = yield* Clock.currentTimeMillis
					const { changes, outcome } = interpretCheck(row, result, now)
					const [updated] = yield* dbExecute((db) =>
						db.transaction(
							Effect.gen(function* () {
								const rows = yield* db.run(
									PG.update(AwsConnections)
										.set({ ...changes, updatedAt: now })
										.where(($) => [$.id.eq(row.id)])
										.returning(),
								)
								if (outcome !== null) yield* reportPoll(db, row.sourceId, outcome, now)
								return rows
							}),
						),
					)
					yield* Effect.annotateCurrentSpan({
						"maple.aws.check_outcome": result._tag === "Ok" ? "ok" : result.error.kind,
					})
					// Deleted while AWS answered: there is nothing left to report on.
					if (updated === undefined) return yield* notFound()
					return { row: updated, ok: result._tag === "Ok" }
				})

			const check = Effect.fn("AwsConnectionService.check")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.aws.connection_id": connectionId })
				if (signer === undefined) return yield* unavailable()
				const row = yield* selectRow(orgId, connectionId)
				// Every check spends Maple's one identity, whose STS limits all tenants share: a click within
				// seconds of a good check answers with it. A pending one always asks: the stack may be new.
				const now = yield* Clock.currentTimeMillis
				const recent =
					row.lastCheckedAt !== null && now - row.lastCheckedAt < MANUAL_CHECK_INTERVAL_MS
				if (recent && row.verifiedAt !== null && row.lastCheckError === null) {
					return connectionOf(row)
				}
				return connectionOf((yield* runCheck(signer, row)).row)
			})

			/** One batch: the oldest due connections, never-checked ones first, claimed and checked. */
			const sweepBatch = Effect.fn("AwsConnectionService.sweepBatch")(function* (
				signer: AwsOidcSigner,
				deadlineAt: number,
			) {
				const now = yield* Clock.currentTimeMillis
				// A paused source is left out here, so it neither reads AWS nor holds a place in the limit.
				const due = yield* dbExecute((db) =>
					db.run(
						PG.from(AwsConnections)
							.innerJoin(Sources, "s", (connection, source) =>
								connection.sourceId.eq(source.id),
							)
							.select(($) => ({ id: $.id, lastCheckedAt: $.lastCheckedAt }))
							.where(($) => [
								PG.or($.lastCheckedAt.isNull(), $.lastCheckedAt.lt(now - CHECK_INTERVAL_MS)),
								PG.or($.checkLeaseUntil.isNull(), $.checkLeaseUntil.lt(now)),
								PG.or(
									$.s.pausedAt.isNull(),
									PG.and($.s.pausedUntil.isNotNull(), $.s.pausedUntil.lte(now)),
								),
							])
							// `false` sorts first: a connection never checked goes ahead of every stale one.
							.orderBy(($) => [
								[PG.asBoolean($.lastCheckedAt.isNotNull()), "asc"],
								[$.lastCheckedAt, "asc"],
								[$.id, "asc"],
							])
							.limit(SWEEP_LIMIT),
					),
				)
				// One conditional write claims the batch: rows a concurrent sweep holds are left out.
				const claimed =
					due.length === 0
						? []
						: yield* dbExecute((db) =>
								db.run(
									PG.update(AwsConnections)
										.set({ checkLeaseUntil: now + CHECK_LEASE_MS })
										.where(($) => [
											PG.inList(
												$.id,
												due.map((row) => row.id),
											),
											PG.or($.checkLeaseUntil.isNull(), $.checkLeaseUntil.lt(now)),
										])
										.returning(),
								),
							)
				// RETURNING keeps no order: check in the due order, never-checked first.
				const rank = new Map(due.map((row, index) => [row.id, index]))
				const ordered = [...claimed].sort(
					(a, b) =>
						(rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
						(rank.get(b.id) ?? Number.MAX_SAFE_INTEGER),
				)
				const results = yield* Effect.forEach(
					ordered,
					(row) =>
						// Past the budget no check starts: a slow AWS cannot carry a batch past the lane's
						// deadline, and the rows left stay leased, then come due again.
						Effect.flatMap(Clock.currentTimeMillis, (now) =>
							now >= deadlineAt
								? Effect.succeed(undefined)
								: runCheck(signer, row).pipe(Effect.map(({ ok }) => ok)),
						).pipe(
							Effect.withSpan("AwsConnectionService.checkDue.connection", {
								attributes: { orgId: row.orgId, "maple.aws.connection_id": row.id },
							}),
							// One connection's failure, expected or not, is that connection's alone.
							Effect.catchCause((cause) =>
								Effect.logWarning("AWS connection check failed").pipe(
									Effect.annotateLogs({
										"maple.aws.connection_id": row.id,
										cause: Cause.pretty(cause),
									}),
									Effect.as(false),
								),
							),
						),
					{ concurrency: SWEEP_CONCURRENCY },
				)
				const ran = results.filter((ok) => ok !== undefined)
				return { due: due.length, checked: ran.length, failures: ran.filter((ok) => !ok).length }
			})

			/**
			 * Batches until none is full or the budget is spent: a lane checks every due connection,
			 * however many, and stops short of its deadline. What it leaves stays leased, then due.
			 */
			const sweepFrom = (
				signer: AwsOidcSigner,
				startedAt: number,
				total: AwsCheckSweep,
			): Effect.Effect<AwsCheckSweep, IntegrationsPersistenceError> =>
				sweepBatch(signer, startedAt + SWEEP_BUDGET_MS).pipe(
					Effect.flatMap((batch) =>
						Effect.flatMap(Clock.currentTimeMillis, (now) => {
							const next = {
								due: total.due + batch.due,
								checked: total.checked + batch.checked,
								failures: total.failures + batch.failures,
							}
							return batch.due < SWEEP_LIMIT || now - startedAt >= SWEEP_BUDGET_MS
								? Effect.succeed(next)
								: sweepFrom(signer, startedAt, next)
						}),
					),
				)

			const checkDue = Effect.fn("AwsConnectionService.checkDue")(function* () {
				if (signer === undefined) return { due: 0, checked: 0, failures: 0 }
				const startedAt = yield* Clock.currentTimeMillis
				return yield* sweepFrom(signer, startedAt, { due: 0, checked: 0, failures: 0 })
			})

			const deleteConnection = Effect.fn("AwsConnectionService.delete")(function* (
				orgId: OrgId,
				connectionId: AwsConnectionId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.aws.connection_id": connectionId })
				const current = yield* selectRow(orgId, connectionId)
				// Rendered first: once the row is gone, a failed render would lose the only cleanup.
				const names = awsConnectionResourceNames(current.id)
				const cleanupScript = yield* renderAwsCleanupScript({
					accountId: current.accountId,
					stackName: names.stackName,
					metricsStackName: names.metricsStackName,
					oidcProvider: awsSetupPlan({
						connectionId: current.id,
						accountId: current.accountId,
						issuer,
						modules: [],
					}).oidcProvider,
				})
				// Its source goes with it.
				const [row] = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const deleted = yield* db.run(
								PG.deleteFrom(AwsConnections)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(connectionId)])
									.returning(),
							)
							yield* deleteSourcesOf(db, orgId, deleted, "aws")
							return deleted
						}),
					),
				)
				if (row === undefined) return yield* notFound()
				return { connection: connectionOf(row), cleanupScript }
			})

			return {
				status,
				create,
				update,
				setup,
				check,
				checkDue,
				delete: deleteConnection,
			} satisfies AwsConnectionServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
