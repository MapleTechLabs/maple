import type {
	AlertDestinationId,
	AlertIncidentId,
	EscalationChainId,
	OnCallScheduleId,
	UserId,
} from "@maple/domain/http"
import type {
	V2AlertIncidentEscalation,
	V2EscalationChain,
	V2EscalationChainCreateParams,
} from "@maple/domain/http/v2"
import { formatAlertTimeNear } from "@maple/web-data/alerts/form-utils"
import { Array as Arr, Effect, Option } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"

// Escalation chain reads and writes as Effects the pages' Commands wrap, and how a chain and an
// incident's run read in one line.

/** An org holds at most 100 chains, one v2 page. */
export const CHAIN_LIST_LIMIT = 100

/** 409 on delete while a rule tier still names the chain. */
export const CHAIN_IN_USE_CODE = "escalation_chain_in_use"

export const listEscalationChains = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const page = yield* client.escalationChains.list({ query: { limit: CHAIN_LIST_LIMIT } })
	return page.data
}).pipe(Effect.mapError(toLoadFailure))

/** Creates a chain, or replaces `editingId`'s fields with the form's. */
export const saveEscalationChain = (
	editingId: EscalationChainId | null,
	payload: V2EscalationChainCreateParams,
) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return editingId === null
			? yield* client.escalationChains.create({ payload })
			: yield* client.escalationChains.update({
					params: { id: editingId },
					payload: { ...payload, repeat_count: payload.repeat_count ?? 0 },
				})
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteEscalationChain = (id: EscalationChainId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.escalationChains.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** The incident's latest escalation run, from its v2 document. */
export const retrieveIncidentEscalation = (id: AlertIncidentId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const incident = yield* client.alertIncidents.retrieve({ params: { id } })
		return incident.escalation
	}).pipe(Effect.mapError(toLoadFailure))

export const routingTabHref = (): string => hrefOf(AppRoute.Alerts({ search: { tab: "routing" } }))

// SUMMARY

/** `10m`, `1h`, `1h 30m`, `1d`. */
export const formatWait = (minutes: number): string => {
	if (minutes < 60) return `${minutes}m`
	if (minutes === 1440) return "1d"
	const hours = Math.floor(minutes / 60)
	const rest = minutes % 60
	return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`
}

/** "A", "A and B", "A and 2 more". */
const namesOf = (names: ReadonlyArray<string>): string =>
	names.length <= 2 ? Arr.join(names, " and ") : `${names[0]} and ${names.length - 1} more`

const repeatPhrase = (count: number): string =>
	count === 0
		? ""
		: count === 1
			? "; repeats once"
			: count === 2
				? "; repeats twice"
				: `; repeats ${count} times`

/** How a summary names the people and schedules a step pages; without them, generic words. */
export type TargetNames = Readonly<{
	userName?: (id: UserId) => string
	scheduleName?: (id: OnCallScheduleId) => string
}>

/**
 * One line for a chain: "Slack #alerts-api, then PagerDuty after 10m, then email after 15m;
 * repeats twice". Each step waits for an ack before the next, so a step's delay is the one before it.
 */
export const chainSummary = (
	chain: Pick<V2EscalationChain, "steps" | "repeat_count">,
	nameOf: (id: AlertDestinationId) => string,
	people: TargetNames = {},
): string => {
	const parts = Arr.map(chain.steps, (step, index) => {
		const names = namesOf(
			Arr.map(step.targets, (target) =>
				target.type === "destination"
					? nameOf(target.destination_id)
					: target.type === "user"
						? (people.userName?.(target.user_id) ?? "a team member")
						: Option.match(Option.fromNullishOr(people.scheduleName?.(target.schedule_id)), {
								onNone: () => "the on-call",
								onSome: (name) => `whoever is on call on ${name}`,
							}),
			),
		)
		const previous = index === 0 ? undefined : chain.steps[index - 1]
		return previous === undefined ? names : `then ${names} after ${formatWait(previous.wait_minutes)}`
	})
	return `${Arr.join(parts, ", ")}${repeatPhrase(chain.repeat_count)}`
}

// INCIDENT RUN

export type RunState = "escalating" | "paused" | "finished"

export type RunView = Readonly<{
	state: RunState
	/** "Escalating", "Paused: acknowledged", "Finished". */
	label: string
	/** "Step 2 of 3, next page at 14:25", or why it ended. */
	detail: string
}>

const ENDED = {
	resolved: "Ended when the incident resolved",
	exhausted: "Every step was sent",
	superseded: "Replaced by the critical tier's chain",
} as const

/** How an incident's run reads in the rail. An acknowledged incident pauses it before the scheduler's next tick does. */
export const runView = (
	run: V2AlertIncidentEscalation,
	isAcknowledged: boolean,
	timeZone: string,
	nowMs: number,
): RunView => {
	const position = `Step ${run.step} of ${run.step_count}${run.pass_count > 1 ? `, pass ${run.pass} of ${run.pass_count}` : ""}`
	if (run.status === "resolved" || run.status === "exhausted" || run.status === "superseded")
		return { state: "finished", label: "Finished", detail: ENDED[run.status] }
	if (run.status === "acknowledged" || isAcknowledged)
		return {
			state: "paused",
			label: "Paused: acknowledged",
			detail: `${position}. Resumes if the incident is unacknowledged`,
		}
	return {
		state: "escalating",
		label: "Escalating",
		detail:
			run.next_step_at === null
				? position
				: `${position}, next page at ${formatAlertTimeNear(run.next_step_at, timeZone, nowMs)}`,
	}
}
