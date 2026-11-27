import { HttpApiBuilder } from "effect/http-api"
import type { AlertIncidentDocument, OrgId } from "@maple/domain/http"
import { AlertIncidentNotFoundError, CurrentTenant } from "@maple/domain/http"
import type { V2WidgetPage } from "@maple/domain/http/v2"
import { MapleApiV2, timestamp, WIDGET_PAGES_LIMIT } from "@maple/domain/http/v2"
import type { UserId } from "@maple/primitives"
import { Clock, DateTime, Duration, Effect, Option, Array as Arr } from "effect"
import {
	displayGroup,
	formatSignalMetric,
	formatThresholdSummary,
} from "@maple/backend/services/alerts/alert-formatting"
import { resolveSignalDisplay } from "@maple/backend/services/alerts/alert-signal-display"
import { AlertIncidentAckService } from "@maple/backend/services/alerts/AlertIncidentAckService"
import { AlertIncidentPagesService } from "@maple/backend/services/alerts/AlertIncidentPagesService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { loadIncidentEscalations, type IncidentEscalations } from "./incident-escalations"

/** How a person without a name in the directory reads on a widget row. */
const UNNAMED = "a teammate"

/**
 * An incident as one widget row. A query rule's unit lives on the rule, which this read does not
 * load, so its numbers stand bare; every preset signal formats as it does everywhere else.
 */
const toWidgetPage = (
	doc: AlertIncidentDocument,
	escalations: IncidentEscalations,
	viewer: UserId,
): V2WidgetPage => {
	const display = resolveSignalDisplay({ signalType: doc.signalType })
	const run = escalations.runOf(doc.id)
	const isWaiting = doc.acknowledgedAt === null && run?.status === "active"
	const people = isWaiting ? escalations.nextStepPeopleOf(doc.id) : []
	const [first] = people
	return {
		incident_id: doc.id,
		rule_name: doc.ruleName,
		group: displayGroup({
			groupKey: doc.groupKey,
			groupLabel: doc.groupLabel ?? null,
			signalType: doc.signalType,
		}),
		severity: doc.severity,
		value: formatSignalMetric(doc.lastObservedValue, display),
		threshold: formatThresholdSummary({
			signalType: doc.signalType,
			signalDisplay: display,
			comparator: doc.comparator,
			threshold: doc.threshold,
			thresholdUpper: doc.thresholdUpper,
		}),
		opened_at: doc.firstTriggeredAt,
		acknowledged_by: doc.acknowledgedAt === null ? null : (doc.acknowledgedByName ?? UNNAMED),
		acknowledged_by_you: doc.acknowledgedAt !== null && doc.acknowledgedByUserId === viewer,
		next_page_at: isWaiting ? (run?.nextStepAt ?? null) : null,
		next_page_people:
			first === undefined
				? null
				: people.length === 1
					? (first.name ?? UNNAMED)
					: `${first.name ?? UNNAMED} +${people.length - 1}`,
	}
}

export const HttpV2WidgetPagesLive = HttpApiBuilder.group(MapleApiV2, "widgetPages", (handlers) =>
	Effect.gen(function* () {
		const readModels = yield* AlertReadModelsService
		const pagesService = yield* AlertIncidentPagesService
		const acks = yield* AlertIncidentAckService
		const members = yield* OrgMembersService

		const rowsOf = (orgId: OrgId, viewer: UserId, docs: ReadonlyArray<AlertIncidentDocument>) =>
			Effect.map(loadIncidentEscalations(readModels, pagesService, orgId, docs), (escalations) =>
				Arr.map(docs, (doc) => toWidgetPage(doc, escalations, viewer)),
			)

		return handlers
			.handle("list", () =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					const nowMs = yield* Clock.currentTimeMillis
					// Two reads, so answered incidents can never crowd an unanswered page out of the
					// limit. One past it says whether unanswered ones were left out.
					const half = (acknowledged: boolean) =>
						readModels.listIncidents(tenant.orgId, {
							acknowledged,
							pagedUserId: tenant.userId,
							limit: WIDGET_PAGES_LIMIT + 1,
						})
					const [waiting, answered] = yield* Effect.all([half(false), half(true)], {
						concurrency: 2,
					})
					// What is waiting on an answer leads; the read's own order (most recently
					// triggered) holds within each half.
					const incidents = [...waiting.incidents, ...answered.incidents]
					return {
						object: "widget_pages" as const,
						generated_at: timestamp(DateTime.formatIso(DateTime.makeUnsafe(nowMs))),
						organization_id: tenant.orgId,
						// The widget counts what is unanswered, so only those being cut makes its
						// count a floor; answered incidents left out change nothing it says.
						has_more: waiting.incidents.length > WIDGET_PAGES_LIMIT,
						data: yield* rowsOf(
							tenant.orgId,
							tenant.userId,
							Arr.take(incidents, WIDGET_PAGES_LIMIT),
						),
					}
				}).pipe(Effect.withSpan("HttpV2WidgetPages.list")),
			)
			.handle("acknowledge", ({ params }) =>
				Effect.gen(function* () {
					const tenant = yield* CurrentTenant.Context
					// A widget answers its own pages and nothing else: a credential that lives in an
					// extension must not be able to quiet an escalation that never reached its owner.
					if (!(yield* pagesService.wasPaged(tenant.orgId, params.id, tenant.userId))) {
						return yield* new AlertIncidentNotFoundError({
							message: `No page for you on alert incident '${params.id}'`,
							incidentId: params.id,
						})
					}
					// The name rides on the acknowledgement so every surface can show it without a
					// directory lookup; a slow directory records none rather than delaying the answer.
					const name = Option.getOrNull(
						(yield* members
							.resolveMembers(tenant.orgId, [tenant.userId])
							.pipe(Effect.timeout(Duration.seconds(3)), Effect.option)).pipe(
							Option.flatMap(Arr.head),
							Option.map((member) => member.name ?? member.email),
						),
					)
					const result = yield* acks.acknowledge(tenant.orgId, params.id, {
						userId: tenant.userId,
						name,
						source: "mobile",
					})
					const rows = yield* rowsOf(tenant.orgId, tenant.userId, [result.incident])
					return yield* Effect.fromNullishOr(rows[0]).pipe(Effect.orDie)
				}).pipe(Effect.withSpan("HttpV2WidgetPages.acknowledge")),
			)
	}),
)
