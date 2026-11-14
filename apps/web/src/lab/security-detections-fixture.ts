import {
	AlertDestinationId,
	AlertRuleId,
	type AuditDetection,
	type AuditDetectionListResponse,
} from "@maple/domain/http"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Array as Arr, Schema } from "effect"

// Audit log detections for the Security hub's lab and scene tests: the shapes the list has to
// draw (an exact action, no filters at all, one switched off, one that notifies nobody).

const HOUR = 3_600_000

const ruleId = Schema.decodeSync(AlertRuleId)
const destinationId = Schema.decodeSync(AlertDestinationId)

export const SECURITY_CHANNEL_ID = destinationId("0199b001-0000-7000-8000-000000000001")
export const ON_CALL_ID = destinationId("0199b001-0000-7000-8000-000000000002")

/** The org's alert destinations, as the live sync delivers them. */
export const detectionDestinationsOf = (orgId: string, nowMs: number): ReadonlyArray<AlertDestinationRow> =>
	Arr.map(
		[
			{ id: SECURITY_CHANNEL_ID, name: "#security", type: "slack" },
			{ id: ON_CALL_ID, name: "Security on-call", type: "pagerduty" },
		],
		(destination) => ({
			...destination,
			org_id: orgId,
			enabled: true,
			config_json: { summary: destination.name, channelLabel: null },
			last_tested_at: null,
			last_test_error: null,
			disabled_at: null,
			disabled_reason: null,
			created_at: new Date(nowMs - 30 * 24 * HOUR).toISOString(),
			updated_at: new Date(nowMs - 30 * 24 * HOUR).toISOString(),
		}),
	)

type Seed = Pick<AuditDetection, "name" | "filters" | "threshold" | "windowMinutes" | "severity"> &
	Partial<Pick<AuditDetection, "enabled" | "destinationIds">>

const SEEDS: ReadonlyArray<Seed> = [
	{
		name: "Role changes on Vercel",
		filters: { provider: "vercel", action: "team.member.role.updated" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
	},
	{
		name: "Burst of refused requests",
		filters: { outcome: "denied" },
		threshold: 10,
		windowMinutes: 10,
		severity: "critical",
		destinationIds: [SECURITY_CHANNEL_ID, ON_CALL_ID],
	},
	{
		name: "Credential changes on Google Cloud",
		filters: { provider: "gcp", category: "credential" },
		threshold: 1,
		windowMinutes: 5,
		severity: "warning",
		destinationIds: [],
	},
	{
		name: "Repeated sign-in failures",
		filters: { category: "authentication", outcome: "failure" },
		threshold: 5,
		windowMinutes: 10,
		severity: "critical",
		enabled: false,
	},
	{
		name: "Unusual audit volume",
		filters: {},
		threshold: 500,
		windowMinutes: 60,
		severity: "warning",
	},
]

/** The detections of an org that set a few up, newest first. */
export const detectionsOf = (nowMs: number): AuditDetectionListResponse => ({
	detections: Arr.map(SEEDS, (seed, index) => ({
		id: ruleId(`0199b002-0000-7000-8000-00000000000${index + 1}`),
		enabled: true,
		destinationIds: [SECURITY_CHANNEL_ID],
		createdAt: nowMs - (index + 1) * 26 * HOUR,
		updatedAt: nowMs - (index + 1) * 5 * HOUR,
		...seed,
	})),
})

export const noDetections: AuditDetectionListResponse = { detections: [] }
