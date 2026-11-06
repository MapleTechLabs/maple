/**
 * Drains `alert_member_notifications`, the pages escalation steps queued for people: email, or a
 * direct message through the linked chat workspace. The standard lane runs it after the destination drain.
 */
import {
	alertDeliveryRetryDelayMs,
	canRetryAlertDelivery,
	DEFAULT_ALERT_DELIVERY_RETRY_POLICY,
} from "@maple/alerting-core"
import {
	AlertComparator,
	AlertEventType,
	AlertPersistenceError,
	AlertSeverity,
	AlertSignalType,
	ChatConnectorId,
	type AlertDeliveryFailure,
	type ChatWorkspaceId,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	AlertIncidents,
	AlertMemberNotifications,
	ChatWorkspaces,
	type AlertMemberNotificationRow,
} from "@maple/db/tables"
import { Array as Arr, Context, Effect, Exit, Layer, Option, Random, Ref, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { EmailService } from "@maple/backend/platform/EmailService"
import { Env } from "@maple/backend/platform/Env"
import { OrgMembersService, type OrgMember } from "@maple/backend/services/org/OrgMembersService"
import { buildAlertEmailContent } from "./alert-email"
import { makePersistenceError } from "./alert-persistence"
import { AlertRuntime } from "./AlertRuntime"
import { ChatAlertPoster } from "./ChatAlertPoster"
import { buildChatAlertBlocks, type ChatAlertCardInput } from "./delivery/transports/chat"

const LEASE_TTL_MS = 30_000
const DRAIN_LIMIT = 50
const CONCURRENCY = 3
/** Batches stop once this has passed, so the standard lane's minute tick stays bounded. */
const DRAIN_BUDGET_MS = 20_000
const MAX_ATTEMPTS = DEFAULT_ALERT_DELIVERY_RETRY_POLICY.maxAttempts

/*
 * What a failed page stores. Fixed per failure class: provider text can carry the address, and
 * `error_message` reaches the v2 and MCP timelines.
 */
const FailureMessages = {
	directoryNotConfigured: "Member emails cannot be looked up on this deployment",
	directoryUnavailable: "The member directory could not be read",
	noEmail: "No email address is known for this member",
	emailFailed: "The email could not be sent",
	unreadable: "The stored page could not be read",
	noChatAccount: "The page names no chat account",
	noWorkspaceKnowsUser: "No linked chat workspace could reach this member",
	chatAuth: "The chat workspace refused Maple's credentials",
	chatRejected: "The chat platform refused the direct message",
	chatFailed: "The chat platform could not be reached",
	gaveUp: "Not sent: every attempt was used up",
} as const

/** The stored step payload, read leniently: only what the email and the card show. */
const MemberPayload = Schema.Struct({
	eventType: Schema.optionalKey(Schema.String),
	dedupeKey: Schema.optionalKey(Schema.String),
	linkUrl: Schema.optionalKey(Schema.String),
	rule: Schema.optionalKey(
		Schema.Struct({
			id: Schema.optionalKey(Schema.String),
			name: Schema.optionalKey(Schema.String),
			signalType: Schema.optionalKey(Schema.String),
			severity: Schema.optionalKey(Schema.String),
			groupKey: Schema.optionalKey(Schema.NullOr(Schema.String)),
			comparator: Schema.optionalKey(Schema.String),
			threshold: Schema.optionalKey(Schema.Number),
			thresholdUpper: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			windowMinutes: Schema.optionalKey(Schema.Number),
		}),
	),
	observed: Schema.optionalKey(
		Schema.Struct({
			value: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			sampleCount: Schema.optionalKey(Schema.NullOr(Schema.Number)),
			detail: Schema.optionalKey(Schema.NullOr(Schema.String)),
		}),
	),
	chart: Schema.optionalKey(
		Schema.NullOr(
			Schema.Struct({
				sparkline: Schema.optionalKey(Schema.String),
				url: Schema.optionalKey(Schema.String),
			}),
		),
	),
	recipient: Schema.Struct({
		externalUserId: Schema.optionalKey(Schema.String),
	}),
})
type MemberPayload = Schema.Schema.Type<typeof MemberPayload>

const decodePayload = Schema.decodeUnknownOption(MemberPayload)
const decodeSeverity = Schema.decodeUnknownOption(AlertSeverity)
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const decodeComparator = Schema.decodeUnknownOption(AlertComparator)
const decodeEventType = Schema.decodeUnknownOption(AlertEventType)
const decodeConnectorId = Schema.decodeUnknownOption(ChatConnectorId)

/** What one attempt came to; `retryable` only matters for a failure. */
type Attempt =
	| { readonly status: "sent" }
	| { readonly status: "failed"; readonly message: string; readonly retryable: boolean }

const failure = (message: string, retryable: boolean): Attempt => ({ status: "failed", message, retryable })

const cardInput = (
	row: AlertMemberNotificationRow,
	payload: MemberPayload,
	appBaseUrl: string,
	sentAtMs: number,
): ChatAlertCardInput => {
	const rule = payload.rule
	const fallbackLink = `${appBaseUrl}/alerts/incidents/${encodeURIComponent(row.incidentId)}`
	return {
		context: {
			ruleId: rule?.id ?? "",
			ruleName: rule?.name ?? "Alert",
			groupKey: rule?.groupKey ?? null,
			signalType: Option.getOrElse(decodeSignalType(rule?.signalType), () => "throughput" as const),
			severity: Option.getOrElse(decodeSeverity(rule?.severity), () => "warning" as const),
			comparator: Option.getOrElse(decodeComparator(rule?.comparator), () => "gt" as const),
			threshold: rule?.threshold ?? 0,
			thresholdUpper: rule?.thresholdUpper ?? null,
			windowMinutes: rule?.windowMinutes ?? 5,
			eventType: Option.getOrElse(decodeEventType(payload.eventType), () => "trigger" as const),
			incidentId: row.incidentId,
			incidentStatus: "open",
			dedupeKey: payload.dedupeKey ?? row.dedupeKey,
			value: payload.observed?.value ?? null,
			sampleCount: payload.observed?.sampleCount ?? null,
			detail: payload.observed?.detail ?? null,
			sparkline: payload.chart?.sparkline ?? null,
			chartUrl: payload.chart?.url ?? null,
			sentAtMs,
		},
		templated: null,
		linkUrl: payload.linkUrl ?? fallbackLink,
	}
}

export interface AlertMemberNotifierApi {
	/** Sends every due page; one bad row never stops the rest. */
	readonly drain: Effect.Effect<
		{ readonly processedCount: number; readonly failureCount: number },
		AlertPersistenceError
	>
}

export class AlertMemberNotifier extends Context.Service<AlertMemberNotifier, AlertMemberNotifierApi>()(
	"@maple/backend/services/alerts/AlertMemberNotifier",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const runtime = yield* AlertRuntime
			const orgMembers = yield* OrgMembersService
			const email = yield* EmailService
			const chat = yield* ChatAlertPoster
			const dbExecute = makeDbExecute(database, "AlertMemberNotifier", makePersistenceError)

			const claimable = (
				$: PG.ColumnAccessor<typeof AlertMemberNotifications.columns>,
				nowMs: number,
			) =>
				PG.or(
					PG.and($.status.eq("queued"), $.scheduledAt.lte(nowMs)),
					PG.and($.status.eq("sending"), $.claimExpiresAt.isNotNull(), $.claimExpiresAt.lte(nowMs)),
				)

			/**
			 * Takes the row from the attempt count it was read at and counts this attempt, so a
			 * crash after the claim still spends one. A row out of attempts is failed instead.
			 */
			const claim = (row: AlertMemberNotificationRow, nowMs: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(AlertMemberNotifications)
							.set(
								row.attemptNumber >= MAX_ATTEMPTS
									? {
											status: "failed",
											errorMessage: FailureMessages.gaveUp,
											claimedAt: null,
											claimExpiresAt: null,
											updatedAt: nowMs,
										}
									: {
											status: "sending",
											attemptNumber: row.attemptNumber + 1,
											claimedAt: nowMs,
											claimExpiresAt: nowMs + LEASE_TTL_MS,
											updatedAt: nowMs,
										},
							)
							.where(($) => [
								$.id.eq(row.id),
								$.attemptNumber.eq(row.attemptNumber),
								claimable($, nowMs),
							])
							.returning("id"),
					),
				).pipe(
					Effect.map((rows) =>
						rows.length === 0
							? ("lost" as const)
							: row.attemptNumber >= MAX_ATTEMPTS
								? ("exhausted" as const)
								: ("claimed" as const),
					),
				)

			/** Only the lease this worker took: a row reclaimed after it expired is not overwritten. */
			const settle = (
				row: AlertMemberNotificationRow,
				claimedAt: number,
				set: Partial<PG.InsertRowOf<typeof AlertMemberNotifications>>,
			) =>
				Effect.gen(function* () {
					const nowMs = yield* runtime.now
					yield* dbExecute((db) =>
						db.run(
							PG.update(AlertMemberNotifications)
								.set({ ...set, claimedAt: null, claimExpiresAt: null, updatedAt: nowMs })
								.where(($) => [
									$.id.eq(row.id),
									$.status.eq("sending"),
									$.claimedAt.eq(claimedAt),
								]),
						),
					)
				})

			/** Read after the claim, so an ack or resolve that landed during the drain still wins. */
			const incidentOf = (row: AlertMemberNotificationRow) =>
				dbExecute((db) =>
					db.run(
						PG.from(AlertIncidents)
							.select("status", "acknowledgedAt")
							.where(($) => [$.id.eq(row.incidentId), $.orgId.eq(row.orgId)])
							.limit(1),
					),
				).pipe(Effect.map(Arr.head))

			const sendEmail = (
				row: AlertMemberNotificationRow,
				input: ChatAlertCardInput,
				members: Exit.Exit<ReadonlyArray<OrgMember>, { readonly _tag: string }>,
			) =>
				Effect.gen(function* () {
					if (Exit.isFailure(members)) {
						const notConfigured = Exit.findErrorOption(members).pipe(
							Option.exists(
								(error) =>
									error._tag ===
									"@maple/http/errors/AlertMemberDirectoryNotConfiguredError",
							),
						)
						return notConfigured
							? failure(FailureMessages.directoryNotConfigured, false)
							: failure(FailureMessages.directoryUnavailable, true)
					}
					const member = Arr.findFirst(
						members.value,
						(candidate) => candidate.userId === row.userId,
					)
					if (Option.isNone(member)) {
						return failure(FailureMessages.noEmail, false)
					}
					const content = yield* buildAlertEmailContent(input.context, input.linkUrl)
					return yield* email.send(member.value.email, content.subject, content.html).pipe(
						Effect.as<Attempt>({ status: "sent" }),
						Effect.orElseSucceed(() => failure(FailureMessages.emailFailed, true)),
					)
				}).pipe(Effect.orElseSucceed(() => failure(FailureMessages.emailFailed, false)))

			const chatFailure = (error: AlertDeliveryFailure): Attempt => {
				switch (error._tag) {
					case "@maple/http/errors/AlertDeliveryAuthError":
						return failure(FailureMessages.chatAuth, false)
					case "@maple/http/errors/AlertDeliveryRejectedError":
						return failure(FailureMessages.chatRejected, false)
					case "@maple/http/errors/AlertDeliveryTargetMissingError":
						return failure(FailureMessages.noWorkspaceKnowsUser, false)
					case "@maple/http/errors/AlertDeliveryError":
						return failure(FailureMessages.chatFailed, error.error.retryable)
				}
			}

			/**
			 * Identities do not record their workspace, so each of the org's workspaces on the
			 * connector is tried, oldest first; only "no such user" moves on to the next one.
			 */
			const sendDirectMessage = (
				row: AlertMemberNotificationRow,
				payload: MemberPayload,
				input: ChatAlertCardInput,
			) =>
				Effect.gen(function* () {
					const externalUserId = payload.recipient.externalUserId
					const connector = decodeConnectorId(row.channel)
					if (externalUserId === undefined || Option.isNone(connector)) {
						return failure(FailureMessages.noChatAccount, false)
					}
					const workspaces = yield* dbExecute((db) =>
						db.run(
							PG.from(ChatWorkspaces)
								.select("id", "createdAt")
								.where(($) => [$.orgId.eq(row.orgId), $.connector.eq(connector.value)])
								.orderBy(["createdAt", "asc"], ["id", "asc"]),
						),
					)
					const blocks = buildChatAlertBlocks(input)
					const tryFrom = (ids: ReadonlyArray<ChatWorkspaceId>): Effect.Effect<Attempt> =>
						Arr.match(ids, {
							onEmpty: () =>
								Effect.succeed(failure(FailureMessages.noWorkspaceKnowsUser, false)),
							onNonEmpty: ([workspaceId, ...rest]) =>
								chat
									.postDirect({ orgId: row.orgId, workspaceId, externalUserId, blocks })
									.pipe(
										Effect.as<Attempt>({ status: "sent" }),
										Effect.catch((error: AlertDeliveryFailure) =>
											error._tag ===
											"@maple/http/errors/AlertDeliveryTargetMissingError"
												? tryFrom(rest)
												: Effect.succeed(chatFailure(error)),
										),
									),
						})
					yield* Effect.annotateCurrentSpan("maple.escalation.chat_workspaces", workspaces.length)
					return yield* tryFrom(Arr.map(workspaces, (workspace) => workspace.id))
				}).pipe(
					Effect.catchTag("@maple/http/errors/AlertPersistenceError", () =>
						Effect.succeed(failure(FailureMessages.chatFailed, true)),
					),
				)

			const deliverOne = Effect.fn("AlertMemberNotifier.deliver")(function* (
				row: AlertMemberNotificationRow,
				members: (orgId: OrgId) => Exit.Exit<ReadonlyArray<OrgMember>, { readonly _tag: string }>,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId: row.orgId,
					"maple.alert.incident_id": row.incidentId,
					"maple.escalation.run_id": row.runId,
					"maple.escalation.recipient_channel": row.channel,
					"maple.escalation.attempt": row.attemptNumber + 1,
				})
				const annotateStatus = (status: string) =>
					Effect.annotateCurrentSpan("maple.escalation.recipient_status", status)
				const claimedAt = yield* runtime.now
				const claimed = yield* claim(row, claimedAt)
				if (claimed === "lost") return "lost" as const
				if (claimed === "exhausted") {
					yield* annotateStatus("failed")
					return "failed" as const
				}
				const attemptNumber = row.attemptNumber + 1
				// Same rule as a queued step to a destination: a resolve or ack that won the race wins.
				const incident = yield* incidentOf(row)
				if (
					Option.isNone(incident) ||
					incident.value.status !== "open" ||
					incident.value.acknowledgedAt !== null
				) {
					const acknowledged = Option.isSome(incident) && incident.value.status === "open"
					// A page with earlier attempts was on its way, so it stopped rather than never went.
					const tried = row.attemptNumber > 0
					yield* settle(row, claimedAt, {
						status: "skipped",
						errorMessage: tried
							? acknowledged
								? "Stopped retrying: the incident was acknowledged"
								: "Stopped retrying: the incident resolved"
							: acknowledged
								? "Not sent: the incident was acknowledged before this page went out"
								: "Not sent: the incident resolved before this page went out",
					})
					yield* annotateStatus("skipped")
					return "skipped" as const
				}
				const payload = decodePayload(row.payloadJson)
				const input = Option.map(payload, (value) =>
					cardInput(row, value, env.MAPLE_APP_BASE_URL, claimedAt),
				)
				const attempt: Attempt =
					Option.isNone(payload) || Option.isNone(input)
						? failure(FailureMessages.unreadable, false)
						: row.channel === "email"
							? yield* sendEmail(row, input.value, members(row.orgId))
							: yield* sendDirectMessage(row, payload.value, input.value)
				const attemptedAt = yield* runtime.now
				if (attempt.status === "sent") {
					yield* settle(row, claimedAt, { status: "sent", attemptedAt, errorMessage: null })
					yield* annotateStatus("sent")
					return "sent" as const
				}
				const retry = canRetryAlertDelivery(attemptNumber, attempt.retryable)
				const jitter = yield* Random.nextIntBetween(0, 1_000)
				yield* settle(
					row,
					claimedAt,
					retry
						? {
								status: "queued",
								scheduledAt: attemptedAt + alertDeliveryRetryDelayMs(attemptNumber, jitter),
								attemptedAt,
								errorMessage: attempt.message,
							}
						: { status: "failed", attemptedAt, errorMessage: attempt.message },
				)
				yield* annotateStatus(retry ? "retrying" : "failed")
				// Fixed messages only: never the address or what the platform said about it.
				yield* Effect.logWarning("Escalation page to a member failed").pipe(
					Effect.annotateLogs({
						notificationId: row.id,
						incidentId: row.incidentId,
						channel: row.channel,
						attemptNumber,
						reason: attempt.message,
						willRetry: retry,
					}),
				)
				return "failed" as const
			})

			const drainBatch = (deadline: number) =>
				Effect.gen(function* () {
					const nowMs = yield* runtime.now
					// Across orgs: the scheduler is the system actor.
					const rows = yield* dbExecute((db) =>
						db.run(
							PG.from(AlertMemberNotifications)
								.select()
								.where(($) => [claimable($, nowMs)])
								.orderBy(["scheduledAt", "asc"])
								.limit(DRAIN_LIMIT),
						),
					)
					if (rows.length === 0) return { claimedCount: 0, processedCount: 0, failureCount: 0 }
					// One directory read per org with an email to send.
					const emailOrgs = Arr.dedupe(
						Arr.flatMap(rows, (row) => (row.channel === "email" ? [row.orgId] : [])),
					)
					const directoryEntries = yield* Effect.forEach(
						emailOrgs,
						(orgId) =>
							Effect.map(
								Effect.exit(orgMembers.listMembers(orgId)),
								(exit) => [orgId, exit] as const,
							),
						{ concurrency: CONCURRENCY },
					)
					const directories = new Map(directoryEntries)
					const members = (orgId: OrgId) => directories.get(orgId) ?? Exit.succeed([])
					const outcomes = yield* Effect.forEach(
						rows,
						(row) =>
							Effect.flatMap(runtime.now, (time) =>
								time >= deadline ? Effect.succeed("lost" as const) : deliverOne(row, members),
							).pipe(
								Effect.catchCause((cause) =>
									Effect.logError("Escalation page crashed").pipe(
										Effect.annotateLogs({
											notificationId: row.id,
											cause: summarizeCause(cause),
										}),
										Effect.as("failed" as const),
									),
								),
							),
						{ concurrency: CONCURRENCY },
					)
					return {
						claimedCount: rows.length,
						processedCount: Arr.filter(outcomes, (outcome) => outcome !== "lost").length,
						failureCount: Arr.filter(outcomes, (outcome) => outcome === "failed").length,
					}
				})

			const drain = Effect.gen(function* () {
				const deadline = (yield* runtime.now) + DRAIN_BUDGET_MS
				const totals = yield* Ref.make({ processedCount: 0, failureCount: 0 })
				yield* drainBatch(deadline).pipe(
					Effect.tap((batch) =>
						Ref.update(totals, (sum) => ({
							processedCount: sum.processedCount + batch.processedCount,
							failureCount: sum.failureCount + batch.failureCount,
						})),
					),
					Effect.flatMap((batch) =>
						Effect.map(
							runtime.now,
							(time) => batch.claimedCount === DRAIN_LIMIT && time < deadline,
						),
					),
					Effect.repeat({ while: (more) => more }),
				)
				const result = yield* Ref.get(totals)
				yield* Effect.annotateCurrentSpan({
					"maple.escalation.member_notifications_processed": result.processedCount,
					"maple.escalation.member_notifications_failed": result.failureCount,
				})
				return result
			}).pipe(Effect.withSpan("AlertMemberNotifier.drain"))

			return { drain } satisfies AlertMemberNotifierApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(OrgMembersService.layer, EmailService.layer, ChatAlertPoster.layer)),
	)
}
