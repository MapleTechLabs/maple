/**
 * Drains `alert_member_notifications`, the pages escalation steps queued for people: email, or a
 * direct message through the linked chat workspace. The standard lane runs it after the destination drain.
 */
import { alertDeliveryRetryDelayMs, canRetryAlertDelivery } from "@maple/alerting-core"
import {
	AlertComparator,
	AlertEventType,
	AlertPersistenceError,
	AlertSeverity,
	AlertSignalType,
	ChatWorkspaceId,
	type AlertDeliveryFailure,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertIncidents, AlertMemberNotifications, type AlertMemberNotificationRow } from "@maple/db/tables"
import { Array as Arr, Context, Effect, Exit, Layer, Option, Random, Schema } from "effect"
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
const DRAIN_LIMIT = 100
const CONCURRENCY = 3

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
		workspaceId: Schema.optionalKey(ChatWorkspaceId),
		externalUserId: Schema.optionalKey(Schema.String),
	}),
})
type MemberPayload = Schema.Schema.Type<typeof MemberPayload>

const decodePayload = Schema.decodeUnknownOption(MemberPayload)
const decodeSeverity = Schema.decodeUnknownOption(AlertSeverity)
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const decodeComparator = Schema.decodeUnknownOption(AlertComparator)
const decodeEventType = Schema.decodeUnknownOption(AlertEventType)

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

			const claim = (row: AlertMemberNotificationRow, nowMs: number) =>
				dbExecute((db) =>
					db.run(
						PG.update(AlertMemberNotifications)
							.set({
								status: "sending",
								claimedAt: nowMs,
								claimExpiresAt: nowMs + LEASE_TTL_MS,
								updatedAt: nowMs,
							})
							.where(($) => [$.id.eq(row.id), claimable($, nowMs)])
							.returning("id"),
					),
				).pipe(Effect.map((rows) => rows.length > 0))

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
							? failure("Member emails cannot be looked up on this deployment", false)
							: failure("The member directory could not be read", true)
					}
					const member = Arr.findFirst(
						members.value,
						(candidate) => candidate.userId === row.userId,
					)
					if (Option.isNone(member)) {
						return failure("No email address is known for this member", false)
					}
					const content = yield* buildAlertEmailContent(input.context, input.linkUrl)
					return yield* email.send(member.value.email, content.subject, content.html).pipe(
						Effect.as<Attempt>({ status: "sent" }),
						Effect.catch((error) =>
							Effect.succeed(failure(`Email failed: ${error.message}`, true)),
						),
					)
				}).pipe(Effect.catch((error) => Effect.succeed(failure(error.message, false))))

			const sendDirectMessage = (
				row: AlertMemberNotificationRow,
				payload: MemberPayload,
				input: ChatAlertCardInput,
			) => {
				const { workspaceId, externalUserId } = payload.recipient
				if (workspaceId === undefined || externalUserId === undefined) {
					return Effect.succeed(failure("The page names no chat account", false))
				}
				return chat
					.postDirect({
						orgId: row.orgId,
						workspaceId,
						externalUserId,
						blocks: buildChatAlertBlocks(input),
					})
					.pipe(
						Effect.as<Attempt>({ status: "sent" }),
						Effect.catch((error: AlertDeliveryFailure) =>
							Effect.succeed(failure(error.message, error.error.retryable)),
						),
					)
			}

			const deliverOne = Effect.fn("AlertMemberNotifier.deliver")(function* (
				row: AlertMemberNotificationRow,
				incident: { readonly status: string; readonly acknowledgedAt: number | null } | undefined,
				members: (orgId: OrgId) => Exit.Exit<ReadonlyArray<OrgMember>, { readonly _tag: string }>,
			) {
				yield* Effect.annotateCurrentSpan({
					"maple.org_id": row.orgId,
					"maple.alert.incident_id": row.incidentId,
					"maple.escalation.run_id": row.runId,
					"maple.escalation.recipient_channel": row.channel,
					"maple.escalation.attempt": row.attemptNumber,
				})
				const claimedAt = yield* runtime.now
				if (!(yield* claim(row, claimedAt))) return "lost" as const
				const annotateStatus = (status: string) =>
					Effect.annotateCurrentSpan("maple.escalation.recipient_status", status)
				// Same rule as a queued step to a destination: a resolve or ack that won the race wins.
				if (
					incident === undefined ||
					incident.status !== "open" ||
					incident.acknowledgedAt !== null
				) {
					yield* settle(row, claimedAt, {
						status: "skipped",
						errorMessage:
							incident !== undefined && incident.status === "open"
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
						? failure("The stored page could not be read", false)
						: row.channel === "email"
							? yield* sendEmail(row, input.value, members(row.orgId))
							: yield* sendDirectMessage(row, payload.value, input.value)
				const attemptedAt = yield* runtime.now
				if (attempt.status === "sent") {
					yield* settle(row, claimedAt, { status: "sent", attemptedAt, errorMessage: null })
					yield* annotateStatus("sent")
					return "sent" as const
				}
				const retry = canRetryAlertDelivery(row.attemptNumber, attempt.retryable)
				const jitter = yield* Random.nextIntBetween(0, 1_000)
				yield* settle(
					row,
					claimedAt,
					retry
						? {
								status: "queued",
								attemptNumber: row.attemptNumber + 1,
								scheduledAt:
									attemptedAt + alertDeliveryRetryDelayMs(row.attemptNumber, jitter),
								attemptedAt,
								errorMessage: attempt.message,
							}
						: { status: "failed", attemptedAt, errorMessage: attempt.message },
				)
				yield* annotateStatus(retry ? "retrying" : "failed")
				// The message can carry what the platform said, never the address it was sent to.
				yield* Effect.logWarning("Escalation page to a member failed").pipe(
					Effect.annotateLogs({
						notificationId: row.id,
						incidentId: row.incidentId,
						channel: row.channel,
						attemptNumber: row.attemptNumber,
						willRetry: retry,
					}),
				)
				return "failed" as const
			})

			const drain = Effect.gen(function* () {
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
				yield* Effect.annotateCurrentSpan("maple.escalation.member_notifications", rows.length)
				if (rows.length === 0) return { processedCount: 0, failureCount: 0 }
				const incidentIds = Arr.dedupe(Arr.map(rows, (row) => row.incidentId))
				const incidents = yield* dbExecute((db) =>
					db.run(
						PG.from(AlertIncidents)
							.select("id", "orgId", "status", "acknowledgedAt")
							.where(($) => [$.id.in_(...incidentIds)]),
					),
				)
				const incidentOf = (row: AlertMemberNotificationRow) =>
					Arr.findFirst(
						incidents,
						(incident) => incident.id === row.incidentId && incident.orgId === row.orgId,
					)
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
						deliverOne(row, Option.getOrUndefined(incidentOf(row)), members).pipe(
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
				const processedCount = Arr.filter(outcomes, (outcome) => outcome !== "lost").length
				const failureCount = Arr.filter(outcomes, (outcome) => outcome === "failed").length
				yield* Effect.annotateCurrentSpan({
					"maple.escalation.member_notifications_processed": processedCount,
					"maple.escalation.member_notifications_failed": failureCount,
				})
				return { processedCount, failureCount }
			}).pipe(Effect.withSpan("AlertMemberNotifier.drain"))

			return { drain } satisfies AlertMemberNotifierApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(OrgMembersService.layer, EmailService.layer, ChatAlertPoster.layer)),
	)
}
