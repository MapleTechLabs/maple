/** Pieces the on-call schedule MCP tools share: rows, rotation text, schedule lookup and error mapping. */
import { Array as Arr, DateTime, Effect, Option, Schema, String as Str } from "effect"
import type {
	AlertForbiddenError,
	AlertMemberDirectoryNotConfiguredError,
	AlertMemberDirectoryUnavailableError,
	AlertPersistenceError,
	AlertValidationError,
	OnCallLayer,
	OnCallOverrideDocument,
	OnCallOverrideNotFoundError,
	OnCallRestriction,
	OnCallRotation,
	OnCallScheduleDocument,
	OnCallScheduleNotFoundError,
	OnCallShiftDocument,
	OrgId,
} from "@maple/domain/http"
import { OnCallScheduleId } from "@maple/domain/http"
import { encodePublicId, PublicIdPrefixes, V2OnCallLayers, fromV2OnCallLayer } from "@maple/domain/http/v2"
import type {
	OnCallOverrideRow,
	OnCallPersonRow,
	OnCallScheduleRow,
	OnCallShiftRow,
} from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { McpInvalidInputError } from "../tools/types"
import { toMcpHttpError } from "./map-http-error"
import * as P from "./params"
import { doc } from "./tool-doc"

type ScheduleRow = typeof OnCallScheduleRow.Type
type ShiftRow = typeof OnCallShiftRow.Type
type PersonRow = typeof OnCallPersonRow.Type
export type MemberNames = ReadonlyMap<string, string>

/** The layers a tool takes, in the REST shape. */
export const LayersInput = V2OnCallLayers

export const layersParameterDescription =
	'Layers, bottom first; later layers win where they have someone on call. Each: {"name","participants":["user_…"],"rotation":{"kind":"weekly","handoff_weekday":"mon","handoff_time":"09:00"} | {"kind":"daily","handoff_time":"09:00"} | {"kind":"custom","length_hours":12},"starts_at":"2026-11-09T08:00:00Z" (participant 0 holds the shift containing it),"restrictions":[{"weekdays":["mon"],"start_time":"18:00","end_time":"08:00"}] (optional)}. Participants are Maple user ids of workspace members. At most 5 layers'

export const toLayers = (layers: typeof LayersInput.Type) => Arr.map(layers, fromV2OnCallLayer)

const WEEKDAY_NAMES = {
	mon: "Monday",
	tue: "Tuesday",
	wed: "Wednesday",
	thu: "Thursday",
	fri: "Friday",
	sat: "Saturday",
	sun: "Sunday",
} as const

export const formatRotation = (rotation: OnCallRotation): string => {
	switch (rotation.kind) {
		case "daily":
			return `daily at ${rotation.handoffTime}`
		case "weekly":
			return `weekly, ${WEEKDAY_NAMES[rotation.handoffWeekday]} ${rotation.handoffTime}`
		case "custom":
			return `every ${rotation.lengthHours}h`
	}
}

const formatRestriction = (r: OnCallRestriction): string =>
	`${Arr.join(r.weekdays, ",")} ${r.startTime}-${r.endTime}`

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms))
export const isoMs = (value: string): number => DateTime.toEpochMillis(DateTime.makeUnsafe(value))

export const person = (names: MemberNames, userId: string): PersonRow => ({
	userId,
	name: names.get(userId) ?? null,
})

export const personLabel = (p: PersonRow): string => (p.name === null ? p.userId : `${p.name} (${p.userId})`)

const layerRow = (names: MemberNames) => (layer: OnCallLayer) => ({
	name: layer.name,
	participants: Arr.map(layer.participants, (id) => person(names, id)),
	rotation: formatRotation(layer.rotation),
	startsAt: iso(layer.startsAt),
	restrictions: Arr.map(layer.restrictions ?? [], formatRestriction),
})

export const toShiftRow = (
	shift: OnCallShiftDocument,
	layers: ReadonlyArray<OnCallLayer>,
	names: MemberNames,
): ShiftRow => ({
	user: person(names, shift.userId),
	startsAt: shift.startsAt,
	endsAt: shift.endsAt,
	source: shift.source.kind,
	layerName: shift.source.kind === "layer" ? (layers[shift.source.layerIndex]?.name ?? null) : null,
	overrideId: shift.source.kind === "override" ? shift.source.overrideId : null,
})

export const toScheduleRow = (schedule: OnCallScheduleDocument, names: MemberNames): ScheduleRow => ({
	id: schedule.id,
	publicId: encodePublicId(PublicIdPrefixes.oncallSchedule, schedule.id),
	name: schedule.name,
	description: schedule.description,
	timeZone: schedule.timeZone,
	layers: Arr.map(schedule.layers, layerRow(names)),
	onCallNow:
		schedule.onCallNow === null
			? null
			: {
					user: person(names, schedule.onCallNow.userId),
					startsAt: schedule.onCallNow.startsAt,
					endsAt: schedule.onCallNow.endsAt,
				},
	chainIds: [...schedule.chainIds],
	createdAt: schedule.createdAt,
	updatedAt: schedule.updatedAt,
})

export const toOverrideRow = (
	override: OnCallOverrideDocument,
	names: MemberNames,
): typeof OnCallOverrideRow.Type => ({
	id: override.id,
	publicId: encodePublicId(PublicIdPrefixes.oncallOverride, override.id),
	scheduleId: override.scheduleId,
	user: person(names, override.userId),
	startsAt: override.startsAt,
	endsAt: override.endsAt,
})

/** e.g. `Ana Alves (user_ana) until 2026-11-16T08:00:00.000Z`, or that nobody is. */
export const formatOnCallNow = (schedule: ScheduleRow): string =>
	schedule.onCallNow === null
		? "nobody on call right now"
		: `${personLabel(schedule.onCallNow.user)} on call until ${schedule.onCallNow.endsAt}`

/** One line per layer, e.g. `Primary: weekly, Monday 09:00 · Ana Alves, Ben Brook`. */
export const formatLayers = (schedule: ScheduleRow): string =>
	Arr.join(
		Arr.map(schedule.layers, (layer, index) => {
			const people = Arr.join(
				Arr.map(layer.participants, (p) => p.name ?? p.userId),
				", ",
			)
			const windows =
				layer.restrictions.length === 0 ? "" : ` (only ${Arr.join(layer.restrictions, "; ")})`
			return `${index + 1}. ${layer.name}: ${layer.rotation}${windows}, from ${layer.startsAt} · ${people}`
		}),
		"\n",
	)

export const scheduleBlocks = (schedule: ScheduleRow) => [
	doc.fields([
		["ID", schedule.id],
		["REST id", schedule.publicId],
		["Name", schedule.name],
		["Description", schedule.description ?? undefined],
		["Time zone", schedule.timeZone],
		["On call now", formatOnCallNow(schedule)],
	]),
	doc.text(formatLayers(schedule)),
]

export const scheduleNotFound = (raw: string, parameter = "schedule_id") =>
	new McpInvalidInputError({
		message: `On-call schedule not found: ${raw}. Use list_oncall_schedules to find schedule IDs.`,
		parameter,
	})

const failWith =
	(pipeName: string) =>
	(
		error:
			| AlertForbiddenError
			| AlertPersistenceError
			| AlertMemberDirectoryNotConfiguredError
			| AlertMemberDirectoryUnavailableError,
	) =>
		Effect.fail(toMcpHttpError(pipeName)(error))

const invalid = (parameter: string) => (error: AlertValidationError) =>
	Effect.fail(new McpInvalidInputError({ message: `Invalid on-call request: ${error.message}`, parameter }))

const notFound = (error: OnCallScheduleNotFoundError) => Effect.fail(scheduleNotFound(error.scheduleId))

const writeErrors = (pipeName: string, parameter: string) => ({
	"@maple/http/errors/AlertValidationError": invalid(parameter),
	"@maple/http/errors/AlertForbiddenError": failWith(pipeName),
	"@maple/http/errors/AlertPersistenceError": failWith(pipeName),
	"@maple/http/errors/AlertMemberDirectoryNotConfiguredError": failWith(pipeName),
	"@maple/http/errors/AlertMemberDirectoryUnavailableError": failWith(pipeName),
})

export const createScheduleErrors = writeErrors("create_oncall_schedule", "layers")
export const updateScheduleErrors = {
	...writeErrors("update_oncall_schedule", "layers"),
	"@maple/http/errors/OnCallScheduleNotFoundError": notFound,
}
export const createOverrideErrors = {
	...writeErrors("create_oncall_override", "user_id"),
	"@maple/http/errors/OnCallScheduleNotFoundError": notFound,
}
export const deleteScheduleErrors = {
	"@maple/http/errors/AlertForbiddenError": failWith("delete_oncall_schedule"),
	"@maple/http/errors/AlertPersistenceError": failWith("delete_oncall_schedule"),
	"@maple/http/errors/OnCallScheduleNotFoundError": notFound,
}
export const deleteOverrideErrors = {
	"@maple/http/errors/AlertForbiddenError": failWith("delete_oncall_override"),
	"@maple/http/errors/AlertPersistenceError": failWith("delete_oncall_override"),
	"@maple/http/errors/OnCallScheduleNotFoundError": notFound,
	"@maple/http/errors/OnCallOverrideNotFoundError": (error: OnCallOverrideNotFoundError) =>
		Effect.fail(
			new McpInvalidInputError({
				message: `On-call override not found: ${error.overrideId}.`,
				parameter: "override_id",
			}),
		),
}

const isScheduleId = Schema.is(OnCallScheduleId)

/** A schedule by its UUID, its REST id or its name (case-insensitive). */
export const resolveSchedule = (orgId: OrgId, raw: string, parameter: string) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		const id = Option.filter(P.internalIdOf("oncallSchedule", raw), isScheduleId)
		if (Option.isSome(id)) {
			return yield* schedules.get(orgId, id.value).pipe(
				Effect.catchTags({
					"@maple/http/errors/OnCallScheduleNotFoundError": () =>
						Effect.fail(scheduleNotFound(raw, parameter)),
					"@maple/http/errors/AlertPersistenceError": failWith("who_is_on_call"),
				}),
			)
		}
		const listed = yield* schedules.list(orgId).pipe(Effect.mapError(toMcpHttpError("who_is_on_call")))
		const wanted = Str.toLowerCase(Str.trim(raw))
		return yield* Effect.fromOption(
			Arr.findFirst(listed.schedules, (s) => Str.toLowerCase(s.name) === wanted),
		).pipe(Effect.mapError(() => scheduleNotFound(raw, parameter)))
	})

/** Member display names; the service answers empty when the directory is unavailable. */
export const memberNames = (orgId: OrgId) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		return yield* schedules.memberNames(orgId)
	})
