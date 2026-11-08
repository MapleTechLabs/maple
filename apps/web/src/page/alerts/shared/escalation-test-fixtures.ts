import { encodePublicId, V2AlertIncidentEscalation, V2EscalationChain } from "@maple/domain/http/v2"
import type { AlertDestinationRow } from "@maple/web-data/collections/alerts"
import { Schema, Array as Arr, String as Str } from "effect"
import { destinationRow, NOW } from "./test-rows"

// Escalation chains, their destinations and incident runs for the scene tests and `/lab/escalation`.

const pad = (n: number) => Str.padStart(12, "0")(String(n))
export const chainUuid = (n: number) => `0199a00e-0000-7000-8000-${pad(n)}`
export const chainDestinationUuid = (n: number) => `0199a001-0000-7000-8000-${pad(100 + n)}`
export const chainScheduleUuid = (n: number) => `0199a00f-0000-7000-8000-${pad(200 + n)}`

const NAMES = [
	"Slack #alerts-api",
	"PagerDuty Checkout",
	"Email on-call",
	"Discord #incidents",
	"Webhook to status page",
	"PagerDuty Payments",
	"Slack #eng-leads",
	"Email CTO",
	"Microsoft Teams SRE",
	"Opsgenie platform",
] as const

/** Ten destinations, named after where they page. */
export const chainDestinations: ReadonlyArray<AlertDestinationRow> = Arr.map(NAMES, (name, index) =>
	destinationRow({ id: chainDestinationUuid(index + 1), name }),
)

export type ChainSpec = Readonly<{
	n: number
	name: string
	description?: string | null
	/** Each step's destinations, by `chainDestinationUuid` number, and its wait. */
	steps: ReadonlyArray<
		Readonly<{
			destinations: ReadonlyArray<number>
			wait: number
			/** On-call schedules, by `chainScheduleUuid` number, and member user ids. */
			schedules?: ReadonlyArray<number>
			users?: ReadonlyArray<string>
		}>
	>
	repeat?: number
	ruleIds?: ReadonlyArray<string>
}>

const decodeChain = Schema.decodeUnknownSync(V2EscalationChain)
const iso = new Date(NOW).toISOString()

export const chainOf = (spec: ChainSpec): V2EscalationChain =>
	decodeChain({
		id: encodePublicId("esc", chainUuid(spec.n)),
		object: "escalation_chain",
		name: spec.name,
		description: spec.description ?? null,
		steps: Arr.map(spec.steps, (step) => ({
			targets: [
				...Arr.map(step.destinations, (d) => ({
					type: "destination",
					destination_id: encodePublicId("dest", chainDestinationUuid(d)),
				})),
				...Arr.map(step.users ?? [], (userId) => ({ type: "user", user_id: userId })),
				...Arr.map(step.schedules ?? [], (n) => ({
					type: "schedule",
					schedule_id: encodePublicId("onc", chainScheduleUuid(n)),
				})),
			],
			wait_minutes: step.wait,
		})),
		repeat_count: spec.repeat ?? 0,
		rule_ids: Arr.map(spec.ruleIds ?? [], (id) => encodePublicId("alrt", id)),
		created_at: iso,
		updated_at: iso,
	})

/** Three chains: an everyday one, one with a long name, one with every step it can hold. */
export const populatedChains = (ruleIds: ReadonlyArray<string>): ReadonlyArray<V2EscalationChain> => [
	chainOf({
		n: 1,
		name: "Checkout on-call",
		steps: [
			{ destinations: [1], wait: 10 },
			{ destinations: [2], wait: 15 },
			{ destinations: [3], wait: 30 },
		],
		repeat: 2,
		ruleIds: ruleIds.slice(0, 2),
	}),
	chainOf({
		n: 2,
		name: "Payments platform after-hours escalation for the EU region with leadership on the last step",
		steps: [
			{ destinations: [6, 7], wait: 5 },
			{ destinations: [8], wait: 60 },
		],
		ruleIds: ruleIds.slice(2, 3),
	}),
	chainOf({
		n: 3,
		name: "Everyone, eventually",
		steps: Arr.map(Arr.range(1, 10), (d) => ({ destinations: [d], wait: d * 5 })),
		repeat: 5,
	}),
]

const decodeRun = Schema.decodeUnknownSync(V2AlertIncidentEscalation)

export const runOf = (
	status: V2AlertIncidentEscalation["status"],
	fields: Partial<{ step: number; stepsSent: number; nextStepAt: string | null }> = {},
): V2AlertIncidentEscalation =>
	decodeRun({
		chain_id: encodePublicId("esc", chainUuid(1)),
		chain_name: "Checkout on-call",
		status,
		step: fields.step ?? 2,
		step_count: 3,
		pass: 1,
		pass_count: 3,
		steps_sent: fields.stepsSent ?? 1,
		next_step_at:
			fields.nextStepAt === undefined
				? status === "active"
					? new Date(NOW + 10 * 60_000).toISOString()
					: null
				: fields.nextStepAt,
	})
