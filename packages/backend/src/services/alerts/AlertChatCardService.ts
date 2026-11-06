/**
 * Redraws an alert card Maple already posted to a chat channel, with the incident's current
 * acknowledgement. The card is rebuilt from the delivery that posted it (its snapshotted payload),
 * so an edit keeps the chart, values and template the original showed.
 */
import type { ChatBlock } from "@maple/chat-platform"
import {
	AlertComparator,
	AlertSeverity,
	AlertSignalType,
	type AlertEventType,
	type AlertIncidentId,
	type AlertPersistenceError,
	type OrgId,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { AlertDeliveryEvents, AlertIncidents } from "@maple/db/tables"
import { Context, Effect, Layer, Option, Schema, Array as Arr } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { makePersistenceError } from "./alert-persistence"
import { renderTitleBody } from "./AlertDeliveryDispatch"
import { resolveSignalDisplay } from "./alert-signal-display"
import { decodeStoredAlertRuleMetadata, selectStoredAlertRules } from "./AlertRuleModel"
import { StoredDeliveryPayloadSchema } from "./delivery/stored-payload"
import { buildChatAlertBlocks, incidentAcknowledgedBy } from "./delivery/transports/chat"

export interface AlertChatCardServiceApi {
	/**
	 * The card a chat message carries, redrawn now. `None` when the message is not a firing card
	 * Maple posted for this incident (a digest, another org's message, a delivery too old to redraw).
	 */
	readonly cardForMessage: (
		orgId: OrgId,
		incidentId: AlertIncidentId,
		messageId: string,
	) => Effect.Effect<Option.Option<ReadonlyArray<ChatBlock>>, AlertPersistenceError>
}

const decodePayload = Schema.decodeUnknownOption(StoredDeliveryPayloadSchema)
const decodeSeverity = Schema.decodeUnknownOption(AlertSeverity)
const decodeSignalType = Schema.decodeUnknownOption(AlertSignalType)
const decodeComparator = Schema.decodeUnknownOption(AlertComparator)

export class AlertChatCardService extends Context.Service<AlertChatCardService, AlertChatCardServiceApi>()(
	"@maple/backend/services/alerts/AlertChatCardService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const dbExecute = makeDbExecute(database, "AlertChatCardService", makePersistenceError)

			const cardForMessage = Effect.fn("AlertChatCardService.cardForMessage")(function* (
				orgId: OrgId,
				incidentId: AlertIncidentId,
				messageId: string,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.alert.incident_id": incidentId })
				const [deliveries, incidents] = yield* Effect.all(
					[
						dbExecute((db) =>
							db.run(
								PG.from(AlertDeliveryEvents)
									.select()
									.where(($) => [
										$.orgId.eq(orgId),
										$.incidentId.eq(incidentId),
										$.providerReference.eq(messageId),
										$.status.eq("success"),
										$.eventType.in_("trigger", "renotify"),
									])
									.orderBy(["scheduledAt", "desc"])
									.limit(1),
							),
						),
						dbExecute((db) =>
							db.run(
								PG.from(AlertIncidents)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(incidentId)])
									.limit(1),
							),
						),
					],
					{ concurrency: "unbounded" },
				)
				const delivery = Arr.head(deliveries)
				const incident = Arr.head(incidents)
				if (Option.isNone(delivery) || Option.isNone(incident)) {
					yield* Effect.annotateCurrentSpan("maple.alert.card_found", false)
					return Option.none<ReadonlyArray<ChatBlock>>()
				}
				const row = delivery.value
				const current = incident.value
				const payload = decodePayload(row.payloadJson)
				const linkUrl = Option.flatMap(payload, (value) => Option.fromUndefinedOr(value.linkUrl))
				const signalType = decodeSignalType(current.signalType)
				const comparator = decodeComparator(current.comparator)
				const eventType: AlertEventType = row.eventType === "renotify" ? "renotify" : "trigger"
				if (
					Option.isNone(payload) ||
					Option.isNone(linkUrl) ||
					Option.isNone(signalType) ||
					Option.isNone(comparator)
				) {
					yield* Effect.annotateCurrentSpan("maple.alert.card_found", false)
					return Option.none<ReadonlyArray<ChatBlock>>()
				}
				const stored = payload.value
				const ruleRows = yield* dbExecute((db) =>
					db.run(
						selectStoredAlertRules()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(row.ruleId)])
							.limit(1),
					),
				)
				const ruleRow = Arr.head(ruleRows)
				// A rule whose stored config no longer decodes still redraws, from the snapshot alone.
				const rule = Option.isNone(ruleRow)
					? Option.none()
					: yield* Effect.option(decodeStoredAlertRuleMetadata(ruleRow.value))
				const context = {
					ruleId: row.ruleId,
					ruleName: Option.match(ruleRow, {
						onNone: () => stored.rule?.name ?? current.ruleName,
						onSome: (value) => value.name,
					}),
					eventType,
					severity: Option.getOrElse(
						Option.orElse(decodeSeverity(stored.rule?.severity), () =>
							decodeSeverity(current.severity),
						),
						(): AlertSeverity => "warning",
					),
					signalType: signalType.value,
					signalDisplay: resolveSignalDisplay({
						signalType: signalType.value,
						queryBuilderDraft: Option.match(rule, {
							onNone: () => null,
							onSome: (value) => value.queryBuilderDraft,
						}),
						rawQueryReducer: Option.match(ruleRow, {
							onNone: () => null,
							onSome: (value) => value.reducer,
						}),
					}),
					comparator: comparator.value,
					threshold: current.threshold,
					thresholdUpper: current.thresholdUpper,
					value: stored.observed?.value ?? null,
					sampleCount: stored.observed?.sampleCount ?? null,
					detail: stored.observed?.detail ?? null,
					groupKey: current.groupKey,
					groupLabel: stored.rule?.groupLabel ?? current.groupLabel,
					windowMinutes: Option.match(ruleRow, {
						onNone: () => stored.rule?.windowMinutes ?? 5,
						onSome: (value) => value.windowMinutes,
					}),
					incidentId: current.id,
					incidentStatus: current.status,
					incidentAcknowledgedBy: incidentAcknowledgedBy(current),
					sparkline: stored.chart?.sparkline ?? null,
					chartUrl: stored.chart?.url ?? null,
					dedupeKey: current.dedupeKey,
					template:
						stored.template ??
						Option.match(rule, {
							onNone: () => null,
							onSome: (value) => value.notificationTemplate,
						}),
					sentAtMs: row.attemptedAt ?? row.scheduledAt,
				}
				yield* Effect.annotateCurrentSpan("maple.alert.card_found", true)
				return Option.some(
					buildChatAlertBlocks({
						context,
						templated: renderTitleBody(
							context,
							"chat",
							linkUrl.value,
							stored.chatUrl ?? linkUrl.value,
						),
						linkUrl: linkUrl.value,
					}),
				)
			})

			return { cardForMessage } satisfies AlertChatCardServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
