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
import { queuedDeliveryEventRow, SKIPPED_POST_PREFIX } from "../alert-delivery-rows"
import { StoredDeliveryPayloadSchema } from "./stored-payload"

export const DELETED_RULE_RESOLVE_DETAIL = "Resolved: the alert was deleted"

/**
 * How long the all-clear waits for a page still on its way out: sent first, a pager keyed by
 * incident would take the late page as a new alert.
 */
export const DELETED_RULE_IN_FLIGHT_DELAY_MS = 60_000

const decodeStored = Schema.decodeUnknownOption(StoredDeliveryPayloadSchema)

/** The alerts list of the app `link` points into: the incident and the rule it named are gone. */
const alertsListUrl = (link: string | undefined): Option.Option<string> =>
	link !== undefined && URL.canParse(link)
		? Option.some(new URL("/alerts", link).toString())
		: Option.none()
const decodeComparator = Schema.decodeUnknownOption(AlertComparator)

/**
 * `stored` with its links pointed at the alerts list, for an all-clear that outlives its rule and
 * incident; none when it carries no link to move.
 */
export const relinkedToAlertsList = (stored: unknown): Option.Option<Record<string, unknown>> =>
	Option.gen(function* () {
		const payload = yield* decodeStored(stored)
		const url = yield* alertsListUrl(payload.linkUrl ?? payload.chatUrl)
		return { ...payload, linkUrl: url, chatUrl: url }
	})

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
			...Option.match(alertsListUrl(payload.linkUrl ?? payload.chatUrl), {
				onNone: () => ({}),
				onSome: (url) => ({ linkUrl: url, chatUrl: url }),
			}),
			event,
			eventType: "resolve",
			incidentStatus: "resolved",
			observed: { value: null, sampleCount: null, detail: DELETED_RULE_RESOLVE_DETAIL },
			chart: null,
			sentAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
		}
	})

type PageRow = Pick<AlertDeliveryEventRow, "incidentId" | "destinationId" | "payloadJson">

/** Resolve rows per insert, well inside the statement's bind limit. */
export const DELETED_RULE_RESOLVE_INSERT_CHUNK = 200

/**
 * One queued `resolve` per destination each open incident of `ruleId` paged: a page that left,
 * or may have left (not held by a silence, not still waiting). Read once the pages that never
 * left are deleted, and before the rest are; insert the result after.
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
		// The newest page per incident and destination, picked in SQL: a long run of reminders to
		// one destination cannot crowd out the single page another one got. A post that was
		// deliberately not made told nobody, so it is no page: an older one that went out still counts.
		const latest: ReadonlyArray<PageRow> = yield* db.run(
			PG.from(AlertDeliveryEvents)
				.select("incidentId", "destinationId", "payloadJson")
				.distinctOn("incidentId", "destinationId")
				.where(($) => [
					$.orgId.eq(orgId),
					$.incidentId.in_(...incidentIds),
					$.eventType.in_("trigger", "renotify"),
					$.status.in_("success", "failed", "processing"),
					PG.or(
						$.providerMessage.isNull(),
						PG.not($.providerMessage.startsWith(SKIPPED_POST_PREFIX)),
					),
				])
				.orderBy(($) => [
					[$.incidentId, "asc"],
					[$.destinationId, "asc"],
					[$.createdAt, "desc"],
				]),
		)
		const inFlight = yield* db.run(
			PG.from(AlertDeliveryEvents)
				.select("incidentId", "destinationId")
				.where(($) => [
					$.orgId.eq(orgId),
					$.incidentId.in_(...incidentIds),
					$.eventType.in_("trigger", "renotify"),
					$.status.eq("processing"),
				]),
		)
		const isInFlight = (page: PageRow) =>
			Arr.some(
				inFlight,
				(row) => row.incidentId === page.incidentId && row.destinationId === page.destinationId,
			)
		return Arr.flatMap(latest, (page) => {
			const incidentId = page.incidentId
			if (incidentId === null) return []
			const destinationId: AlertDestinationId = page.destinationId
			const scheduledAt = isInFlight(page) ? nowMs + DELETED_RULE_IN_FLIGHT_DELAY_MS : nowMs
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
						scheduledAt,
						deliveryKey: makeAlertDeliveryKey(incidentId, destinationId, "resolve", nowMs),
						attemptNumber: 1,
					}),
				],
			})
		})
	})
