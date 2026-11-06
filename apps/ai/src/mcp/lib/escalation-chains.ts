/** Pieces the escalation chain MCP tools share: rows, step text, step input and error mapping. */
import { Array as Arr, Effect, Option, Schema } from "effect"
import type {
	AlertDestinationDocument,
	AlertForbiddenError,
	OrgId,
	AlertPersistenceError,
	AlertValidationError,
	EscalationChainDocument,
	EscalationChainInUseError,
	EscalationChainNotFoundError,
} from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes } from "@maple/domain/http/v2"
import type { EscalationChainRow } from "@maple/domain/mcp-outputs"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { McpInvalidInputError } from "../tools/types"
import { toMcpHttpError } from "./map-http-error"
import * as P from "./params"
import { doc } from "./tool-doc"

type ChainRow = typeof EscalationChainRow.Type
type DestinationRef = Pick<AlertDestinationDocument, "id" | "name" | "type">

/** The steps a tool takes: each the destinations it notifies and the minutes it waits. */
export const StepsInput = Schema.Array(
	Schema.Struct({
		destination_ids: Schema.Array(Schema.String).annotate({
			description: "Destinations this step notifies, from list_alert_destinations (UUID or dest_…)",
		}),
		wait_minutes: Schema.Number.annotate({
			description: "Minutes to wait for an acknowledgement before the next step, 1 to 1440",
		}),
	}),
)

export const stepsParameterDescription =
	'Steps in order, each notifying its destinations then waiting for an ack before the next, e.g. [{"destination_ids":["dest_…"],"wait_minutes":10},{"destination_ids":["dest_…"],"wait_minutes":15}]. At most 10 steps of 10 destinations'

/** The steps as the service schema takes them, destination ids decoded to internal ids. */
export const toStepsRequest = (steps: typeof StepsInput.Type) =>
	Effect.forEach(steps, (step) =>
		Effect.map(
			Effect.forEach(step.destination_ids, P.decodeResourceId("alertDestination", "steps")),
			(ids) => ({
				targets: Arr.map(ids, (destinationId) => ({ type: "destination" as const, destinationId })),
				waitMinutes: step.wait_minutes,
			}),
		),
	)

/** Destination names for the rendered steps; a failed read only drops the names. */
export const destinationDirectory = (orgId: OrgId) =>
	Effect.gen(function* () {
		const alerts = yield* AlertsService
		return yield* alerts.listDestinations(orgId).pipe(
			Effect.map((response): ReadonlyArray<DestinationRef> => response.destinations),
			Effect.orElseSucceed((): ReadonlyArray<DestinationRef> => []),
		)
	})

export const toEscalationChainRow = (
	chain: EscalationChainDocument,
	destinations: ReadonlyArray<DestinationRef>,
): ChainRow => ({
	id: chain.id,
	publicId: encodePublicId(PublicIdPrefixes.escalationChain, chain.id),
	name: chain.name,
	description: chain.description,
	steps: Arr.map(chain.steps, (step) => ({
		targets: Arr.map(step.targets, (target) => {
			const known = Option.getOrUndefined(
				Arr.findFirst(destinations, (d) => d.id === target.destinationId),
			)
			return {
				destinationId: target.destinationId,
				name: known?.name ?? null,
				type: known?.type ?? null,
			}
		}),
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

const targetLabel = (target: ChainRow["steps"][number]["targets"][number]): string =>
	target.name === null
		? `destination ${target.destinationId}`
		: target.type === null
			? target.name
			: `${target.name} (${target.type})`

/** One line per step, e.g. `1. notify On-call (pagerduty), then wait 10m for an ack`. */
export const formatSteps = (chain: ChainRow): string =>
	Arr.join(
		Arr.map(
			chain.steps,
			(step, index) =>
				`${index + 1}. notify ${Arr.join(Arr.map(step.targets, targetLabel), ", ")}, then wait ${formatWait(step.waitMinutes)} for an ack`,
		),
		"\n",
	)

export const formatRepeats = (repeatCount: number): string =>
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

const failWith = (pipeName: string) => (error: AlertForbiddenError | AlertPersistenceError) =>
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
}

export const updateChainErrors = {
	"@maple/http/errors/AlertValidationError": invalidChain,
	"@maple/http/errors/EscalationChainNotFoundError": (error: EscalationChainNotFoundError) =>
		Effect.fail(chainNotFound(error.chainId)),
	"@maple/http/errors/AlertForbiddenError": failWith("update_escalation_chain"),
	"@maple/http/errors/AlertPersistenceError": failWith("update_escalation_chain"),
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
