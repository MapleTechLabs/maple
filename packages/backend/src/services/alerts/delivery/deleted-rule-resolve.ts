/**
 * The all-clear for incidents that are open when their rule is deleted. The rule and the
 * incident are gone by the time it is sent, so it is rebuilt from the page it follows.
 */
import { makeAlertDeliveryKey, projectAlertLifecycleEvent } from "@maple/alerting-core"
import { AlertComparator, type AlertDestinationId, type AlertRuleId, type OrgId } from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import type { MapleDb } from "@maple/db/client"
import { AlertDeliveryEvents, AlertIncidents, type AlertDeliveryEventRow } from "@maple/db/tables"
import { Array as Arr, DateTime, Effect, Option, Result, Schema, Struct } from "effect"
import { randomUUID } from "node:crypto"
import { queuedDeliveryEventRow } from "../alert-delivery-rows"
import { StoredDeliveryPayloadSchema } from "./stored-payload"

export const DELETED_RULE_RESOLVE_DETAIL = "Resolved: the alert was deleted"

const decodeStored = Schema.decodeUnknownOption(StoredDeliveryPayloadSchema)
const decodeComparator = Schema.decodeUnknownOption(AlertComparator)

/** `stored` (a trigger or reminder payload) as the resolve that closes it, when it names its rule. */
export const deletedRuleResolvePayload = (
	orgId: OrgId,
	stored: unknown,
	nowMs: number,
): Option.Option<Record<string, unknown>> =>
	Option.gen(function* () {
		const payload = yield* decodeStored(stored)
		const rule = yield* Option.fromNullishOr(payload.rule)
		const ruleId = yield* Option.fromNullishOr(rule.id)
		const comparator = yield* decodeComparator(rule.comparator)
		const event = yield* Result.getSuccess(
			projectAlertLifecycleEvent({
				tenantId: orgId,
				ruleId,
				ruleName: rule.name ?? "Alert",
				incidentId: payload.incidentId ?? null,
				eventType: "resolve",
				incidentStatus: "resolved",
				groupKey: rule.groupKey ?? null,
				signalType: rule.signalType ?? "throughput",
				severity: rule.severity ?? "warning",
				comparator,
				threshold: rule.threshold ?? 0,
				thresholdUpper: rule.thresholdUpper ?? null,
				windowMinutes: rule.windowMinutes ?? 5,
				value: null,
				sampleCount: null,
				occurredAtMs: nowMs,
			}),
		)
		return {
			// An escalation step's marker belongs to the page, not to its all-clear.
			...Struct.omit(payload, ["escalation"]),
			event,
			eventType: "resolve",
			incidentStatus: "resolved",
			observed: { value: null, sampleCount: null, detail: DELETED_RULE_RESOLVE_DETAIL },
			chart: null,
			sentAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
		}
	})

type PageRow = Pick<
	AlertDeliveryEventRow,
	"incidentId" | "destinationId" | "status" | "eventType" | "payloadJson" | "createdAt"
>

// A page that left, or may have left, for the destination: not held by a silence, not still waiting.
const mayHavePaged = (row: PageRow): boolean =>
	(row.eventType === "trigger" || row.eventType === "renotify") &&
	row.status !== "silenced" &&
	row.status !== "queued"

/**
 * One queued `resolve` per destination each open incident of `ruleId` paged. Read before the
 * rule's rows are deleted; insert the result after, so the delete does not take it too.
 */
export const deletedRuleResolveRows = (db: MapleDb, orgId: OrgId, ruleId: AlertRuleId, nowMs: number) =>
	Effect.gen(function* () {
		const open = yield* db.run(
			PG.from(AlertIncidents)
				.select("id")
				.where(($) => [$.orgId.eq(orgId), $.ruleId.eq(ruleId), $.status.eq("open")]),
		)
		const incidentIds = Arr.map(open, (incident) => incident.id)
		if (!Arr.isArrayNonEmpty(incidentIds)) return []
		const pages: ReadonlyArray<PageRow> = yield* db.run(
			PG.from(AlertDeliveryEvents)
				.select("incidentId", "destinationId", "status", "eventType", "payloadJson", "createdAt")
				.where(($) => [$.orgId.eq(orgId), $.incidentId.in_(...incidentIds)])
				.orderBy(["createdAt", "desc"]),
		)
		// Newest first, so the first page seen for a pair is the one the all-clear answers.
		const latest = Arr.dedupeWith(
			Arr.filter(pages, mayHavePaged),
			(a: PageRow, b: PageRow) => a.incidentId === b.incidentId && a.destinationId === b.destinationId,
		)
		return Arr.flatMap(latest, (page) => {
			const incidentId = page.incidentId
			if (incidentId === null) return []
			const destinationId: AlertDestinationId = page.destinationId
			return Option.match(deletedRuleResolvePayload(orgId, page.payloadJson, nowMs), {
				onNone: () => [],
				onSome: (payload) => [
					queuedDeliveryEventRow({
						id: randomUUID(),
						orgId,
						incidentId,
						ruleId,
						destinationId,
						eventType: "resolve",
						payload,
						scheduledAt: nowMs,
						deliveryKey: makeAlertDeliveryKey(incidentId, destinationId, "resolve", nowMs),
						attemptNumber: 1,
					}),
				],
			})
		})
	})
