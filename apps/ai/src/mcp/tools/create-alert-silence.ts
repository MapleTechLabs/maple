import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Clock, DateTime, Effect, Schema } from "effect"
import { AlertSilenceCreateRequest } from "@maple/domain/http"
import { AlertSilenceMutationOutput } from "@maple/domain/mcp-outputs"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { silenceFields, createSilenceErrors, toAlertSilenceRow } from "../lib/alert-silences"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeCreateRequest = Schema.decodeUnknownEffect(AlertSilenceCreateRequest)
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))

/** Only the matcher lists that hold a value, so an empty list never reaches the service. */
const nonEmpty = <K extends string>(key: K, values: ReadonlyArray<string> | undefined) =>
	values === undefined || values.length === 0 ? undefined : { [key]: values }

export function registerCreateAlertSilenceTool(server: McpToolRegistrar) {
	server.define({
		name: "create_alert_silence",
		title: "Create Alert Silence",
		description:
			"Hold back alert notifications for matching rules during a window (maintenance, a known outage). Incidents still open and resolve; only delivery is held. " +
			"Matchers AND together, values inside one OR; pass at least one. services/environments must cover a rule's whole scope or the incident's group. " +
			"Pass duration_minutes or ends_at (max 30 days).",
		parameters: Schema.Struct({
			reason: P.text(
				"Why notifications are held back; shown on the silence and on held-back incidents",
			),
			rule_ids: P.optionalResourceIdList(
				"alertRule",
				"Silence these alert rules (ids from list_alert_rules)",
			),
			tags: P.optionalList("Silence rules carrying any of these tags"),
			services: P.optionalList("Silence rules and incident groups covered by these services"),
			environments: P.optionalList("Silence rules and incident groups covered by these environments"),
			duration_minutes: P.optionalNumber("How long the silence lasts from its start, in minutes"),
			ends_at: P.optionalTimestamp("When the silence ends"),
			starts_at: P.optionalTimestamp("When the silence starts (default: now)"),
		}),
		aliases: { service_names: "services" },
		output: AlertSilenceMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating an alert silence", "Silencing alerts"],
		handler: Effect.fn("McpTool.createAlertSilence")(function* (params) {
			if ((params.duration_minutes === undefined) === (params.ends_at === undefined)) {
				return yield* new McpInvalidInputError({
					message:
						params.ends_at === undefined
							? "Say when the silence ends: pass duration_minutes or ends_at."
							: "Pass duration_minutes or ends_at, not both.",
					parameter: "duration_minutes",
				})
			}
			if (params.duration_minutes !== undefined && params.duration_minutes <= 0) {
				return yield* new McpInvalidInputError({
					message: "duration_minutes must be positive.",
					parameter: "duration_minutes",
				})
			}

			const ruleIds = yield* Effect.forEach(
				params.rule_ids ?? [],
				P.decodeResourceId("alertRule", "rule_ids"),
			)
			const matchers = {
				...nonEmpty("ruleIds", ruleIds),
				...nonEmpty("tags", params.tags),
				...nonEmpty("services", params.services),
				...nonEmpty("environments", params.environments),
			}
			if (Object.keys(matchers).length === 0) {
				return yield* new McpInvalidInputError({
					message:
						"A silence needs at least one matcher: rule_ids, tags, services or environments. Use list_alert_rules to find them.",
					parameter: "rule_ids",
				})
			}

			const nowMs = yield* Clock.currentTimeMillis
			const startsAtMs =
				params.starts_at === undefined ? nowMs : parseWarehouseDateTime(params.starts_at)
			const endsAtMs =
				params.ends_at === undefined
					? startsAtMs + (params.duration_minutes ?? 0) * 60_000
					: parseWarehouseDateTime(params.ends_at)
			const request = yield* decodeCreateRequest({
				reason: params.reason,
				matchers,
				...(params.starts_at === undefined ? undefined : { startsAt: isoAt(startsAtMs) }),
				endsAt: isoAt(endsAtMs),
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({ message: `Invalid alert silence: ${String(error)}` }),
				),
			)

			const tenant = yield* CurrentMcpTenant
			const silences = yield* AlertSilencesService
			const silence = yield* silences
				.create(tenant.orgId, tenant.userId, tenant.roles, request)
				.pipe(Effect.catchTags(createSilenceErrors))

			return { silence: toAlertSilenceRow(silence) }
		}),
		render: (output) => ({
			title: "Alert Silence Created",
			blocks: [silenceFields(output.silence)],
			next: [
				doc.next("list_alert_silences", {}, "every active and scheduled silence"),
				doc.next("end_alert_silence", { silence_id: output.silence.id }, "end it early"),
			],
		}),
	})
}
