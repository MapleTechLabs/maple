import { Array as Arr, Effect } from "effect"
import type {
	AlertForbiddenError,
	AlertMaintenanceWindowDocument,
	AlertMaintenanceWindowNotFoundError,
	AlertPersistenceError,
	AlertValidationError,
} from "@maple/domain/http"
import type { MaintenanceWindowRow } from "@maple/domain/mcp-outputs"
import { McpInvalidInputError } from "../tools/types"
import { toMcpHttpError } from "./map-http-error"
import { doc } from "./tool-doc"

type WindowRow = typeof MaintenanceWindowRow.Type

export const MAINTENANCE_WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const

const listOf = <K extends string>(key: K, values: ReadonlyArray<string> | undefined) =>
	values === undefined ? undefined : { [key]: [...values] }

export const toMaintenanceWindowRow = (window: AlertMaintenanceWindowDocument): WindowRow => ({
	id: window.id,
	name: window.name,
	reason: window.reason,
	matchers: {
		...listOf("ruleIds", window.matchers.ruleIds),
		...listOf("tags", window.matchers.tags),
		...listOf("services", window.matchers.services),
		...listOf("environments", window.matchers.environments),
	},
	schedule:
		window.schedule._tag === "once"
			? { type: "once", startsAt: window.schedule.startsAt, endsAt: window.schedule.endsAt }
			: {
					type: "weekly",
					timeZone: window.schedule.timeZone,
					days: [...window.schedule.days],
					startTime: window.schedule.startTime,
					durationMinutes: window.schedule.durationMinutes,
				},
	excludeFromBaselines: window.excludeFromBaselines,
	enabled: window.enabled,
	nextOccurrence: window.nextOccurrence,
	createdBy: window.createdBy,
})

/** `weekly sat,sun 02:00 Europe/Berlin for 120m`, or the one-off window's bounds. */
export const formatSchedule = (schedule: WindowRow["schedule"]): string =>
	schedule.type === "once"
		? `once ${schedule.startsAt ?? "?"} to ${schedule.endsAt ?? "?"}`
		: `weekly ${Arr.join(schedule.days ?? [], ",")} ${schedule.startTime ?? "?"} ${schedule.timeZone ?? "?"} for ${schedule.durationMinutes ?? "?"}m`

/** The matchers as one line, e.g. `services: checkout AND environments: production`. */
export const formatWindowMatchers = (matchers: WindowRow["matchers"]): string => {
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

const formatNext = (window: WindowRow) =>
	window.nextOccurrence === null
		? "-"
		: `${window.nextOccurrence.startsAt} to ${window.nextOccurrence.endsAt}`

/** Only service and environment matchers keep hours out of anomaly baselines. */
const baselineExclusion = (window: WindowRow): string => {
	if (!window.excludeFromBaselines) return "no"
	const scoped =
		(window.matchers.services?.length ?? 0) > 0 || (window.matchers.environments?.length ?? 0) > 0
	return scoped ? "yes" : "no (only service or environment matchers affect baselines)"
}

export const maintenanceWindowFields = (window: WindowRow) =>
	doc.fields([
		["ID", window.id],
		["Name", window.name],
		["Reason", window.reason ?? "-"],
		["Schedule", formatSchedule(window.schedule)],
		["Matches", formatWindowMatchers(window.matchers)],
		["Next occurrence", formatNext(window)],
		["Enabled", window.enabled ? "yes" : "no"],
		["Excluded from baselines", baselineExclusion(window)],
	])

export const maintenanceWindowTableRow = (window: WindowRow) => [
	window.id,
	window.name,
	formatSchedule(window.schedule),
	formatWindowMatchers(window.matchers),
	formatNext(window),
	window.enabled ? "yes" : "no",
]

const failWith = (pipeName: string) => (error: AlertForbiddenError | AlertPersistenceError) =>
	Effect.fail(toMcpHttpError(pipeName)(error))

/** create_maintenance_window failures: an invalid schedule or matcher is the caller's to fix. */
export const createWindowErrors = {
	"@maple/http/errors/AlertValidationError": (error: AlertValidationError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: Arr.join(
					[
						`Invalid maintenance window: ${error.message}`,
						...Arr.filter(error.details, (detail) => detail !== error.message),
					],
					". ",
				),
			}),
		),
	"@maple/http/errors/AlertForbiddenError": failWith("create_maintenance_window"),
	"@maple/http/errors/AlertPersistenceError": failWith("create_maintenance_window"),
}

/** delete_maintenance_window failures: an unknown id is invalid input on maintenance_window_id. */
export const deleteWindowErrors = {
	"@maple/http/errors/AlertMaintenanceWindowNotFoundError": (error: AlertMaintenanceWindowNotFoundError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: `Maintenance window not found: ${error.maintenanceWindowId}. Use list_maintenance_windows to find window IDs.`,
				parameter: "maintenance_window_id",
			}),
		),
	"@maple/http/errors/AlertForbiddenError": failWith("delete_maintenance_window"),
	"@maple/http/errors/AlertPersistenceError": failWith("delete_maintenance_window"),
}
