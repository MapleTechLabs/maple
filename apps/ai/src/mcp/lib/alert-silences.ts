import { Array as Arr, Effect } from "effect"
import type {
	AlertForbiddenError,
	AlertPersistenceError,
	AlertSilenceDocument,
	AlertSilenceMatchers,
	AlertSilenceNotFoundError,
	AlertValidationError,
} from "@maple/domain/http"
import type { AlertSilenceRow } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError } from "../tools/types"
import { toMcpHttpError } from "./map-http-error"
import { doc } from "./tool-doc"

export const ALERT_SILENCE_STATUSES = ["scheduled", "active", "ended"] as const

type SilenceRow = typeof AlertSilenceRow.Type

export const toAlertSilenceRow = (silence: AlertSilenceDocument): SilenceRow => ({
	id: silence.id,
	reason: silence.reason,
	matchers: {
		...(silence.matchers.ruleIds === undefined ? undefined : { ruleIds: [...silence.matchers.ruleIds] }),
		...(silence.matchers.tags === undefined ? undefined : { tags: [...silence.matchers.tags] }),
		...(silence.matchers.services === undefined
			? undefined
			: { services: [...silence.matchers.services] }),
		...(silence.matchers.environments === undefined
			? undefined
			: { environments: [...silence.matchers.environments] }),
	},
	status: silence.status,
	startsAt: silence.startsAt,
	endsAt: silence.endsAt,
	createdBy: silence.createdBy,
})

/** The matchers as one line, e.g. `services: checkout AND environments: production`. */
export const formatSilenceMatchers = (matchers: SilenceRow["matchers"] | AlertSilenceMatchers): string => {
	const entries: ReadonlyArray<readonly [string, ReadonlyArray<string> | undefined]> = [
		["rules", matchers.ruleIds],
		["tags", matchers.tags],
		["services", matchers.services],
		["environments", matchers.environments],
	]
	const parts = Arr.flatMap(entries, ([label, values]) =>
		values === undefined || values.length === 0 ? [] : [`${label}: ${Arr.join(values, ", ")}`],
	)
	return parts.length === 0 ? "-" : Arr.join(parts, " AND ")
}

export const silenceFields = (silence: SilenceRow) =>
	doc.fields([
		["ID", silence.id],
		["Reason", silence.reason],
		["Status", silence.status],
		["Matches", formatSilenceMatchers(silence.matchers)],
		["Starts", silence.startsAt],
		["Ends", silence.endsAt],
		["Created by", silence.createdBy],
	])

export const silenceNotFound = (silenceId: string) =>
	new McpInvalidInputError({
		message: `Alert silence not found: ${silenceId}. Use list_alert_silences to find silence IDs.`,
		parameter: "silence_id",
	})

const failWith = (pipeName: string) => (error: AlertForbiddenError | AlertPersistenceError) =>
	Effect.fail(toMcpHttpError(pipeName)(error))

/** create_alert_silence failures: an invalid window or matcher is the caller's to fix. */
export const createSilenceErrors = {
	// The details name what to fix (which rule ids do not exist), so they ride along.
	"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: Arr.join(
					[
						`Invalid alert silence: ${error.message}`,
						...Arr.filter(error.details, (detail) => detail !== error.message),
					],
					". ",
				),
			}),
		),
	"@maple/http/errors/AlertForbiddenError": failWith("create_alert_silence"),
	"@maple/http/errors/AlertPersistenceError": failWith("create_alert_silence"),
}

/** end_alert_silence failures: an unknown id is invalid input on silence_id. */
export const endSilenceErrors = {
	"@maple/http/errors/AlertSilenceNotFoundError": (error: AlertSilenceNotFoundError) =>
		Effect.fail(silenceNotFound(error.silenceId)),
	// A maintenance window's silence is ended through the window.
	"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
		Effect.fail(new McpInvalidInputError({ message: error.message, parameter: "silence_id" })),
	"@maple/http/errors/AlertForbiddenError": failWith("end_alert_silence"),
	"@maple/http/errors/AlertPersistenceError": failWith("end_alert_silence"),
}
