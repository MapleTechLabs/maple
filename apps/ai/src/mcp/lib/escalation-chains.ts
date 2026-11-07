/** Pieces the escalation chain MCP tools share: rows, step text, step input and error mapping. */
import { Array as Arr, Effect, Option, Schema, SchemaIssue } from "effect"
import {
	UserId,
	type AlertDestinationDocument,
	type AlertForbiddenError,
	type AlertMemberDirectoryUnavailableError,
	type OrgId,
	type AlertPersistenceError,
	type AlertValidationError,
	type EscalationChainDocument,
	type EscalationChainInUseError,
	type EscalationChainNotFoundError,
	type EscalationTarget,
} from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { EscalationChainRow } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { McpInvalidInputError } from "../tools/types"
import { toMcpHttpError } from "./map-http-error"
import * as P from "./params"
import { doc } from "./tool-doc"

type ChainRow = typeof EscalationChainRow.Type
type DestinationRef = Pick<AlertDestinationDocument, "id" | "name" | "type">

/** Names the rendered steps show; each part is empty when it could not be read. */
export interface TargetDirectory {
	readonly destinations: ReadonlyArray<DestinationRef>
	readonly members: ReadonlyMap<string, string>
	readonly schedules: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/** The steps a tool takes: each the destinations, people and schedules it pages, and its wait. */
export const StepsInput = Schema.Array(
	Schema.Struct({
		destination_ids: Schema.optionalKey(
			Schema.Array(Schema.String).annotate({
				description: "Destinations this step notifies, from list_alert_destinations (UUID or dest_…)",
			}),
		),
		user_ids: Schema.optionalKey(
			Schema.Array(Schema.String).annotate({
				description:
					"Members this step pages by email and chat direct message (Maple user ids, user_…)",
			}),
		),
		schedule_ids: Schema.optionalKey(
			Schema.Array(Schema.String).annotate({
				description:
					"On-call schedules whose on-call person this step pages, from list_oncall_schedules (UUID or onc_…)",
			}),
		),
		wait_minutes: Schema.Number.annotate({
			description: "Minutes to wait for an acknowledgement before the next step, 1 to 1440",
		}),
	}),
)

export const stepsParameterDescription =
	'Steps in order, each paging its targets then waiting for an ack before the next, e.g. [{"schedule_ids":["onc_…"],"wait_minutes":10},{"user_ids":["user_…"],"destination_ids":["dest_…"],"wait_minutes":15}]. A step names at least one of destination_ids (alert destinations), user_ids (members, paged by email and chat DM) or schedule_ids (whoever is on call then). At most 10 steps of 10 targets'

const decodeUserId = Schema.decodeUnknownEffect(UserId)

/** The steps as the service schema takes them, ids decoded to internal ids. */
export const toStepsRequest = (steps: typeof StepsInput.Type) =>
	Effect.forEach(steps, (step) =>
		Effect.gen(function* () {
			const destinationIds = yield* Effect.forEach(
				step.destination_ids ?? [],
				P.decodeResourceId("alertDestination", "steps"),
			)
			const userIds = yield* Effect.forEach(step.user_ids ?? [], (raw) =>
				decodeUserId(raw).pipe(
					Effect.mapError(
						() =>
							new McpInvalidInputError({
								message: `Not a user id: ${raw}`,
								parameter: "steps",
							}),
					),
				),
			)
			const scheduleIds = yield* Effect.forEach(
				step.schedule_ids ?? [],
				P.decodeResourceId("oncallSchedule", "steps"),
			)
			const targets: ReadonlyArray<EscalationTarget> = [
				...Arr.map(destinationIds, (destinationId) => ({
					type: "destination" as const,
					destinationId,
				})),
				...Arr.map(userIds, (userId) => ({ type: "user" as const, userId })),
				...Arr.map(scheduleIds, (scheduleId) => ({ type: "schedule" as const, scheduleId })),
			]
			return { targets, waitMinutes: step.wait_minutes }
		}),
	)

/** Names for the rendered steps; a failed read only drops the names. */
export const targetDirectory = (orgId: OrgId) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService
		const schedules = yield* OnCallSchedulesService
		const [destinations, members, scheduleList] = yield* Effect.all(
			[
				alerts.listDestinations(orgId).pipe(
					Effect.map((response): ReadonlyArray<DestinationRef> => response.destinations),
					Effect.orElseSucceed((): ReadonlyArray<DestinationRef> => []),
				),
				schedules.memberNames(orgId),
				schedules.list(orgId).pipe(
					Effect.map((response) =>
						Arr.map(response.schedules, (s) => ({ id: s.id, name: s.name })),
					),
					Effect.orElseSucceed(() => []),
				),
			],
			{ concurrency: "unbounded" },
		)
		return { destinations, members, schedules: scheduleList } satisfies TargetDirectory
	})

const toTargetRow = (
	target: EscalationTarget,
	directory: TargetDirectory,
): ChainRow["steps"][number]["targets"][number] => {
	switch (target.type) {
		case "destination": {
			const known = Option.getOrUndefined(
				Arr.findFirst(directory.destinations, (d) => d.id === target.destinationId),
			)
			return {
				kind: "destination",
				id: target.destinationId,
				publicId: encodePublicId(PublicIdPrefixes.alertDestination, target.destinationId),
				name: known?.name ?? null,
				type: known?.type ?? null,
			}
		}
		case "user":
			return {
				kind: "user",
				id: target.userId,
				publicId: target.userId,
				name: directory.members.get(target.userId) ?? null,
				type: null,
			}
		case "schedule":
			return {
				kind: "schedule",
				id: target.scheduleId,
				publicId: encodePublicId(PublicIdPrefixes.oncallSchedule, target.scheduleId),
				name: Option.getOrNull(
					Option.map(
						Arr.findFirst(directory.schedules, (s) => s.id === target.scheduleId),
						(s) => s.name,
					),
				),
				type: null,
			}
	}
}

export const toEscalationChainRow = (
	chain: EscalationChainDocument,
	directory: TargetDirectory,
): ChainRow => ({
	id: chain.id,
	publicId: encodePublicId(PublicIdPrefixes.escalationChain, chain.id),
	name: chain.name,
	description: chain.description,
	steps: Arr.map(chain.steps, (step) => ({
		targets: Arr.map(step.targets, (target) => toTargetRow(target, directory)),
		waitMinutes: step.waitMinutes,
	})),
	repeatCount: chain.repeatCount,
	ruleIds: [...chain.ruleIds],
	createdAt: chain.createdAt,
	updatedAt: chain.updatedAt,
})

const formatWait = (minutes: number): string =>
	minutes < 60
		? `${minutes}m`
		: minutes % 60 === 0
			? `${minutes / 60}h`
			: `${Math.floor(minutes / 60)}h ${minutes % 60}m`

const targetLabel = (target: ChainRow["steps"][number]["targets"][number]): string => {
	switch (target.kind) {
		case "destination":
			return target.name === null
				? `destination ${target.publicId}`
				: target.type === null
					? `${target.name} (${target.publicId})`
					: `${target.name} (${target.type}, ${target.publicId})`
		case "user":
			return target.name === null ? `user ${target.publicId}` : `${target.name} (${target.publicId})`
		case "schedule":
			return `whoever is on call on ${target.name === null ? `schedule ${target.publicId}` : `${target.name} (${target.publicId})`}`
	}
}

/** One line per step, e.g. `1. notify On-call (pagerduty, dest_…), Ana (user_…), then wait 10m for an ack`. */
const formatSteps = (chain: ChainRow): string =>
	Arr.join(
		Arr.map(
			chain.steps,
			(step, index) =>
				`${index + 1}. notify ${Arr.join(Arr.map(step.targets, targetLabel), ", ")}, then wait ${formatWait(step.waitMinutes)} for an ack`,
		),
		"\n",
	)

const formatRepeats = (repeatCount: number): string =>
	repeatCount === 0 ? "runs once" : `repeats ${repeatCount} more time${repeatCount === 1 ? "" : "s"}`

export const chainBlocks = (chain: ChainRow) => [
	doc.fields([
		["ID", chain.id],
		["REST id", chain.publicId],
		["Name", chain.name],
		["Description", chain.description ?? undefined],
		["Passes", formatRepeats(chain.repeatCount)],
		["Used by rules", chain.ruleIds.length > 0 ? Arr.join(chain.ruleIds, ", ") : "none"],
	]),
	doc.text(formatSteps(chain)),
]

export const chainNotFound = (chainId: string) =>
	new McpInvalidInputError({
		message: `Escalation chain not found: ${chainId}. Use list_escalation_chains to find chain IDs.`,
		parameter: "chain_id",
	})

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1()

/** A service request key as the tool spells it: a parameter, or a key inside `steps`. */
const toolKey = (segment: PropertyKey): string => {
	const key = String(segment)
	switch (key) {
		case "repeatCount":
			return "repeat_count"
		case "waitMinutes":
			return "wait_minutes"
		default:
			return key
	}
}

/** A request that failed to decode, reported against the parameter its first issue is under. */
export const invalidChainRequest = (error: Schema.SchemaError): McpInvalidInputError => {
	const first = formatIssues(error.issue).issues[0]
	const issuePath = Arr.map(first?.path ?? [], (segment) =>
		typeof segment === "object" && segment !== null ? segment.key : segment,
	)
	// A step's targets come from three id lists, so a targets issue is reported on the step.
	const targetsAt = Arr.findFirstIndex(issuePath, (segment) => segment === "targets")
	const path = Option.match(targetsAt, { onNone: () => issuePath, onSome: (at) => issuePath.slice(0, at) })
	const [root] = path
	const location = Arr.join(
		Arr.map(path, (segment, index) =>
			typeof segment === "number" ? `[${segment}]` : `${index === 0 ? "" : "."}${toolKey(segment)}`,
		),
		"",
	)
	const issueMessage = first?.message ?? String(error)
	const message = Option.match(targetsAt, {
		onNone: () => issueMessage,
		onSome: (at) =>
			at === issuePath.length - 1
				? `destination_ids, user_ids and schedule_ids together: ${issueMessage}`
				: "needs at least one id in destination_ids, user_ids or schedule_ids",
	})
	return new McpInvalidInputError({
		message: location === "" ? `Invalid escalation chain: ${message}` : `${location}: ${message}`,
		parameter: root === undefined ? "steps" : toolKey(root),
	})
}

const failWith =
	(pipeName: string) =>
	(error: AlertForbiddenError | AlertPersistenceError | AlertMemberDirectoryUnavailableError) =>
		Effect.fail(toMcpHttpError(pipeName)(error))

const invalidChain = (error: AlertValidationError) =>
	Effect.fail(
		new McpInvalidInputError({
			message: `Invalid escalation chain: ${error.message}`,
			parameter: "steps",
		}),
	)

export const createChainErrors = {
	"@maple/http/errors/AlertValidationError": invalidChain,
	"@maple/http/errors/AlertForbiddenError": failWith("create_escalation_chain"),
	"@maple/http/errors/AlertPersistenceError": failWith("create_escalation_chain"),
	"@maple/http/errors/AlertMemberDirectoryUnavailableError": failWith("create_escalation_chain"),
}

export const updateChainErrors = {
	"@maple/http/errors/AlertValidationError": invalidChain,
	"@maple/http/errors/EscalationChainNotFoundError": (error: EscalationChainNotFoundError) =>
		Effect.fail(chainNotFound(error.chainId)),
	"@maple/http/errors/AlertForbiddenError": failWith("update_escalation_chain"),
	"@maple/http/errors/AlertPersistenceError": failWith("update_escalation_chain"),
	"@maple/http/errors/AlertMemberDirectoryUnavailableError": failWith("update_escalation_chain"),
}

export const deleteChainErrors = {
	"@maple/http/errors/EscalationChainNotFoundError": (error: EscalationChainNotFoundError) =>
		Effect.fail(chainNotFound(error.chainId)),
	"@maple/http/errors/EscalationChainInUseError": (error: EscalationChainInUseError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: `Escalation chain is still used by ${Arr.join(
					Arr.map(error.ruleIds, (id, index) => `"${error.ruleNames[index] ?? id}" (${id})`),
					", ",
				)}. Detach it first with update_alert_rule escalation_chain_id="none" and escalation_chain_tier set to the tier that names it, so another tier's chain stays. A tier that pages only through the chain needs a destination first: add_destination_ids adds to a one-tier rule or a two-tier rule's warning tier; a critical tier gains one by replacing the rule's thresholds in the v2 API or the dashboard.`,
				parameter: "chain_id",
			}),
		),
	"@maple/http/errors/AlertForbiddenError": failWith("delete_escalation_chain"),
	"@maple/http/errors/AlertPersistenceError": failWith("delete_escalation_chain"),
}
