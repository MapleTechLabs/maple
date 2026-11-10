import { AuditActorType, AuditOutcome } from "@maple/domain/http"
import type { V2AuditLogEntry } from "@maple/domain/http/v2"
/** Entries per audit log page. */
const AUDIT_LOG_PAGE_LIMIT = 50
import {
	AUDIT_RANGE_PRESETS,
	type AuditDateRange,
	type AuditLogFilters,
	auditLogKindOf,
	auditLogSearchFrom,
	parseAuditLogSearch,
	parseAuditLookup,
} from "../kit/audit-log-filters"
import { formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine/datetime"
import * as CustomRange from "../../kit/custom-range"
import { Clock, DateTime, Effect, Option, Result, Schema, Array as Arr, String as Str } from "effect"
import { Command } from "foldkit"
import { settleTo } from "@maple/views/data/load-failure"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import { memberDisplayName } from "../kit/members"
import { AppRoute, hrefOf } from "../../../route"
import type { SettingsSearch as SettingsSearchSchema } from "../../../route/search"
import * as CopyButton from "@maple/views/ui/copy-button"
import * as Popover from "@maple/views/ui/popover"
import * as Select from "@maple/views/ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { Message, type Model, PageRequest } from "./model"

type Return = PageReturn<Model, Message>
type SettingsSearch = typeof SettingsSearchSchema.Type

export const ANYONE = "anyone"
/** The "no filter" value of the resource type, action and affected user selects. */
export const ANY = "any"

const asActorType = Schema.decodeUnknownOption(AuditActorType)
const asOutcome = Schema.decodeUnknownOption(AuditOutcome)

/** The filter input `AuditLogSection` derives from the URL; a rolling preset resolves in the Command. */
export const baseRequestOf = (filters: AuditLogFilters): PageRequest => {
	const range = filters.range
	const kind = auditLogKindOf(filters)
	return {
		...(kind !== "all" && { kind }),
		...(filters.resourceType !== undefined && { resourceType: filters.resourceType }),
		...(filters.action !== undefined && { action: filters.action }),
		...(filters.resourceId !== undefined && { resourceId: filters.resourceId }),
		...(filters.affectedUserId !== undefined && { affectedUserId: filters.affectedUserId }),
		...(filters.requestId !== undefined && { requestId: filters.requestId }),
		...(filters.actorType !== undefined && { actorType: filters.actorType }),
		...(filters.actorId !== undefined && { actorId: filters.actorId }),
		...(filters.outcome !== undefined && { outcome: filters.outcome }),
		...(range.kind === "custom" && range.since !== undefined && { since: range.since }),
		...(range.kind === "custom" && range.until !== undefined && { until: range.until }),
		...(range.kind === "preset" && { preset: range.preset }),
	}
}

const presetMsOf = (range: AuditDateRange): number | null =>
	range.kind === "preset"
		? Option.match(
				Arr.findFirst(AUDIT_RANGE_PRESETS, (preset) => preset.value === range.preset),
				{ onNone: () => null, onSome: (preset) => preset.ms ?? null },
			)
		: null

const REQUEST_KEYS = [
	"cursor",
	"kind",
	"actorType",
	"actorId",
	"outcome",
	"resourceType",
	"action",
	"resourceId",
	"affectedUserId",
	"requestId",
	"since",
	"until",
	"preset",
] as const satisfies ReadonlyArray<keyof PageRequest>

const sameRequest = (a: PageRequest, b: PageRequest) => Arr.every(REQUEST_KEYS, (key) => a[key] === b[key])

/** `auditLogPageAtom`: one page, newest first; a preset window resolves against the clock now. */
const FetchAuditPage = Command.define("FetchAuditLogPage", {
	args: {
		request: PageRequest,
		presetMs: Schema.NullOr(Schema.Number),
		resolvedSince: Schema.NullOr(Schema.String),
	},
	messages: [Message.CompletedFetchPage],
	execute: ({ request, presetMs, resolvedSince }) => {
		// A later page or a retry reuses the window its list started with.
		const resolve = Effect.map(Clock.currentTimeMillis, (now) =>
			presetMs === null ? null : (resolvedSince ?? new Date(now - presetMs).toISOString()),
		)
		return Effect.flatMap(resolve, (presetSince) => fetchPage(request, presetSince))
	},
})

const fetchPage = (request: PageRequest, presetSince: string | null) =>
	Effect.gen(function* () {
		const since = presetSince ?? request.since
		const client = yield* MapleApiV2Client
		const response = yield* client.auditLog.list({
			query: {
				limit: AUDIT_LOG_PAGE_LIMIT,
				...(request.cursor !== undefined && { cursor: request.cursor }),
				kind: request.kind ?? "all",
				...(request.resourceType !== undefined && { resource_type: request.resourceType }),
				...(request.action !== undefined && { action: request.action }),
				...(request.resourceId !== undefined && { resource_id: request.resourceId }),
				...(request.affectedUserId !== undefined && { affected_user: request.affectedUserId }),
				...(request.requestId !== undefined && { request_id: request.requestId }),
				...(request.actorType !== undefined && { actor_type: request.actorType }),
				...(request.actorId !== undefined && { actor_id: request.actorId }),
				...(request.outcome !== undefined && { outcome: request.outcome }),
				...(since !== undefined && { since }),
				...(request.until !== undefined && { until: request.until }),
			},
		})
		return { data: response.data, has_more: response.has_more, next_cursor: response.next_cursor }
	}).pipe(settleTo((result) => Message.CompletedFetchPage({ request, resolvedSince: presetSince, result })))

/** `useOrganization({ memberships: { pageSize: 100 } })`: members by user id; none on a failed read. */
const FetchAuditMembers = Command.define("FetchAuditLogMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) => clerkTry("", () => organization.getMemberships({ pageSize: 100 }))),
		Effect.map((page) =>
			Arr.flatMap(page.data, (membership) => {
				const userId = membership.publicUserData?.userId
				return userId === undefined || userId === null
					? []
					: [{ value: userId, label: memberDisplayName(membership.publicUserData) ?? userId }]
			}),
		),
		Effect.orElseSucceed(() => []),
		Effect.map((members) => Message.CompletedFetchMembers({ members })),
	),
})

/** `resolvedSince`: `null` starts the list's window afresh; a later page or a retry passes its own. */
const fetch = (
	model: Model,
	request: PageRequest,
	search: SettingsSearch,
	resolvedSince: string | null = null,
): Return => ({
	// A cursor-less request starts a list; a later page keeps the filters it continues.
	model: {
		...model,
		request,
		base: request.cursor === undefined ? request : model.base,
		isWaiting: true,
		isQuiet: false,
		failure: null,
	},
	commands: [
		FetchAuditPage({ request, presetMs: presetMsOf(parseAuditLogSearch(search).range), resolvedSince }),
	],
})

export const init = (search: SettingsSearch): Return => {
	const started = fetch(
		{
			request: {},
			base: {},
			isWaiting: true,
			isQuiet: false,
			failure: null,
			view: null,
			pinnedUntil: null,
			resolvedSince: null,
			members: [],
			expanded: [],
			copies: {},
			personSelect: Select.init("audit-person", { value: ANYONE, selectedIndex: 0 }),
			resourceTypeSelect: Select.init("audit-resource-type", { value: ANY, selectedIndex: 0 }),
			actionSelect: Select.init("audit-action", { value: ANY, selectedIndex: 0 }),
			affectedSelect: Select.init("audit-affected", { value: ANY, selectedIndex: 0 }),
			dateRange: Popover.init("audit-date-range", { align: "start" }),
			customRange: null,
			lookup: "",
			isLookupUnknown: false,
		},
		baseRequestOf(parseAuditLogSearch(search)),
		search,
	)
	// Self-hosted runs without Clerk: there is no member directory to list.
	return {
		...started,
		commands: [...(started.commands ?? []), ...(isClerkAuthEnabled ? [FetchAuditMembers()] : [])],
	}
}

/** A filter change (toolbar, shared link, back/forward) restarts the list. */
export const searchChanged = (model: Model, search: SettingsSearch): Return => {
	const base = baseRequestOf(parseAuditLogSearch(search))
	return sameRequest(base, model.base) ? { model } : fetch({ ...model, pinnedUntil: null }, base, search)
}

const dedupeById = (existing: ReadonlyArray<V2AuditLogEntry>, next: ReadonlyArray<V2AuditLogEntry>) => {
	const seen = new Set(Arr.map(existing, (entry) => entry.id))
	return [...existing, ...Arr.filter(next, (entry) => !seen.has(entry.id))]
}

/** `setFilters`: the new filters replace the URL's audit params (`navigate({ replace: true })`). */
const navigateFilters = (model: Model, search: SettingsSearch, filters: AuditLogFilters): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefOf(AppRoute.Settings({ search: { ...search, ...auditLogSearchFrom(filters) } })),
		isReplace: true,
	}),
})

const toggled = (values: ReadonlyArray<string>, value: string) =>
	values.includes(value) ? Arr.filter(values, (entry) => entry !== value) : [...values, value]

/** Back on the tab: its first page reads again behind the list, quietly, as nobody asked for it. */
export const revisit = (model: Model, search: SettingsSearch): Return => {
	const filters = parseAuditLogSearch(search)
	const request = baseRequestOf(filters)
	// The same first page still in flight answers it: a second read could land out of order.
	if (model.isWaiting && sameRequest(request, model.request)) return { model }
	return {
		model: {
			...model,
			request,
			base: request,
			pinnedUntil: null,
			isWaiting: true,
			isQuiet: model.view !== null,
			failure: null,
		},
		commands: [FetchAuditPage({ request, presetMs: presetMsOf(filters.range), resolvedSince: null })],
	}
}

/** "Custom range…" opens on the list's own window once the clock gave today. */
const ResolveAuditCustomToday = Command.define("ResolveAuditCustomToday", {
	args: { timeZone: Schema.String },
	messages: [Message.ResolvedCustomToday],
	execute: ({ timeZone }) =>
		Effect.map(CustomRange.readToday(timeZone), (days) =>
			Message.ResolvedCustomToday({ timeZone, ...days }),
		),
})

const isoToWarehouse = (iso: string | undefined): string | null =>
	iso === undefined ? null : formatWarehouseDateTime(DateTime.toEpochMillis(DateTime.makeUnsafe(iso)))
const warehouseToIso = (value: string): string => new Date(parseWarehouseDateTime(value)).toISOString()

type SelectField = "personSelect" | "resourceTypeSelect" | "actionSelect" | "affectedSelect"

/** One select's step; `onChange` turns a picked value into the filters to navigate to. */
const selectStep = (
	model: Model,
	search: SettingsSearch,
	field: SelectField,
	child: Select.Message,
	wrap: (message: Select.Message) => Message,
	onChange: (value: string) => AuditLogFilters,
): Return => {
	const step = Select.update(model[field], child)
	const lifted: Return = {
		model: { ...model, [field]: step.model },
		commands: Command.mapMessages(step.commands ?? [], wrap),
	}
	if (step.outMessage === undefined) return lifted
	return {
		...lifted,
		outMessage: navigateFilters(lifted.model, search, onChange(step.outMessage.value)).outMessage,
	}
}

const orAny = (value: string) => (value === ANY ? undefined : value)

/** The filters without one of them: what a chip's x navigates to. */
const withoutFilter = (filters: AuditLogFilters, key: string): AuditLogFilters => {
	switch (key) {
		case "range":
			return { ...filters, range: { kind: "all" } }
		case "resourceType":
			// An action belongs to its resource type; it goes with it.
			return { ...filters, resourceType: undefined, action: undefined }
		case "actorId":
		case "actorType":
		case "outcome":
		case "action":
		case "resourceId":
		case "affectedUserId":
		case "requestId":
			return { ...filters, [key]: undefined }
		default:
			return filters
	}
}

const liftCustom = (model: Model, customRange: CustomRange.Model | null): Model => ({ ...model, customRange })

export const update = (model: Model, message: Message, search: SettingsSearch): Return => {
	const filters = parseAuditLogSearch(search)
	return Message.match<Return>(message, {
		CompletedFetchMembers: ({ members }) => ({ model: { ...model, members } }),
		CompletedFetchPage: ({ request, resolvedSince, result }) => {
			if (!sameRequest(request, model.request)) return { model }
			return Result.match(result, {
				onSuccess: (page) => ({
					model: {
						...model,
						resolvedSince,
						isWaiting: false,
						isQuiet: false,
						failure: null,
						view: {
							entries:
								request.cursor === undefined
									? page.data
									: dedupeById(model.view?.entries ?? [], page.data),
							hasMore: page.has_more,
							nextCursor: page.next_cursor,
						},
					},
				}),
				onFailure: (failure) => ({
					model: { ...model, resolvedSince, isWaiting: false, isQuiet: false, failure },
				}),
			})
		},
		ClickedRefresh: () => fetch({ ...model, pinnedUntil: null }, baseRequestOf(filters), search),
		ClickedRetry: () => fetch(model, model.request, search, model.resolvedSince),
		ClickedLoadMore: () => {
			const view = model.view
			if (view === null || view.nextCursor === null || model.isWaiting) return { model }
			const pinnedUntil = model.pinnedUntil ?? view.entries[0]?.occurred_at ?? null
			return fetch(
				{ ...model, pinnedUntil },
				{
					...baseRequestOf(filters),
					cursor: view.nextCursor,
					...(pinnedUntil !== null && { until: pinnedUntil }),
				},
				search,
				model.resolvedSince,
			)
		},
		ToggledEntry: ({ id }) => ({ model: { ...model, expanded: toggled(model.expanded, id) } }),
		GotCopyMessage: ({ key, message: child }) => {
			const step = CopyButton.update(model.copies[key] ?? CopyButton.init(), child)
			return {
				model: { ...model, copies: { ...model.copies, [key]: step.model } },
				commands: Command.mapMessages(step.commands, (inner) =>
					Message.GotCopyMessage({ key, message: inner }),
				),
			}
		},
		ClickedActorType: ({ value }) =>
			navigateFilters(model, search, {
				...filters,
				actorType: Option.getOrUndefined(asActorType(value)),
			}),
		ClickedOutcome: ({ value }) =>
			navigateFilters(model, search, { ...filters, outcome: Option.getOrUndefined(asOutcome(value)) }),
		GotPersonSelectMessage: ({ message: child }) =>
			selectStep(
				model,
				search,
				"personSelect",
				child,
				(inner) => Message.GotPersonSelectMessage({ message: inner }),
				(value) => ({ ...filters, actorId: value === ANYONE ? undefined : value }),
			),
		GotResourceTypeSelectMessage: ({ message: child }) =>
			selectStep(
				model,
				search,
				"resourceTypeSelect",
				child,
				(inner) => Message.GotResourceTypeSelectMessage({ message: inner }),
				(value) => ({ ...filters, resourceType: orAny(value), action: undefined }),
			),
		GotActionSelectMessage: ({ message: child }) =>
			selectStep(
				model,
				search,
				"actionSelect",
				child,
				(inner) => Message.GotActionSelectMessage({ message: inner }),
				(value) => ({ ...filters, action: orAny(value) }),
			),
		GotAffectedSelectMessage: ({ message: child }) =>
			selectStep(
				model,
				search,
				"affectedSelect",
				child,
				(inner) => Message.GotAffectedSelectMessage({ message: inner }),
				(value) => ({ ...filters, affectedUserId: orAny(value) }),
			),
		ClickedKind: ({ value }) =>
			navigateFilters(model, search, {
				...filters,
				kind: value === "access" || value === "all" ? value : undefined,
			}),
		ChangedLookup: ({ value }) => ({ model: { ...model, lookup: value, isLookupUnknown: false } }),
		ClearedLookup: () => ({ model: { ...model, lookup: "", isLookupUnknown: false } }),
		SubmittedLookup: () =>
			Option.match(parseAuditLookup(model.lookup), {
				onNone: () => ({
					model: { ...model, isLookupUnknown: Str.isNonEmpty(Str.trim(model.lookup)) },
				}),
				onSome: (lookup) =>
					navigateFilters({ ...model, lookup: "", isLookupUnknown: false }, search, {
						...filters,
						[lookup.key]: lookup.value,
						// A looked-up action names its resource type; a stale one would hide it.
						...(lookup.key === "action" && { resourceType: undefined }),
					}),
			}),
		RemovedFilter: ({ key }) => navigateFilters(model, search, withoutFilter(filters, key)),
		ClickedCustomRange: ({ timeZone }) => ({ model, commands: [ResolveAuditCustomToday({ timeZone })] }),
		ResolvedCustomToday: ({ timeZone, today, lastDay }) => {
			const range = filters.range
			return {
				model: liftCustom(
					model,
					CustomRange.init({
						startTime: range.kind === "custom" ? isoToWarehouse(range.since) : null,
						endTime: range.kind === "custom" ? isoToWarehouse(range.until) : null,
						timeZone,
						today,
						lastDay,
					}),
				),
			}
		},
		GotCustomRangeMessage: ({ message: child }) => {
			if (model.customRange === null) return { model }
			const step = CustomRange.update(model.customRange, child)
			const out = step.outMessage
			if (out === undefined) return { model: liftCustom(model, step.model) }
			return CustomRange.OutMessage.match<Return>(out, {
				CancelledRange: () => ({ model: liftCustom(model, null) }),
				AppliedRange: ({ startTime, endTime }) => {
					const closed = Popover.close(model.dateRange)
					return {
						...navigateFilters({ ...liftCustom(model, null), dateRange: closed.model }, search, {
							...filters,
							range: {
								kind: "custom",
								since: warehouseToIso(startTime),
								until: warehouseToIso(endTime),
							},
						}),
						commands: Command.mapMessages(closed.commands ?? [], (inner) =>
							Message.GotDateRangeMessage({ message: inner }),
						),
					}
				},
			})
		},
		GotDateRangeMessage: ({ message: child }) => {
			const step = Popover.update(model.dateRange, child)
			return {
				// Closing the popover drops a half-picked custom range.
				model: { ...model, dateRange: step.model, ...(!step.model.isOpen && { customRange: null }) },
				commands: Command.mapMessages(step.commands ?? [], (inner) =>
					Message.GotDateRangeMessage({ message: inner }),
				),
			}
		},
		ClickedRangePreset: ({ value }) => {
			const closed = Popover.close(model.dateRange)
			const range: AuditDateRange = Option.match(
				Arr.findFirst(AUDIT_RANGE_PRESETS, (option) => option.value === value),
				{
					onNone: (): AuditDateRange => ({ kind: "all" }),
					onSome: (preset): AuditDateRange => ({ kind: "preset", preset: preset.value }),
				},
			)
			return {
				...navigateFilters({ ...model, dateRange: closed.model }, search, { ...filters, range }),
				commands: Command.mapMessages(closed.commands ?? [], (inner) =>
					Message.GotDateRangeMessage({ message: inner }),
				),
			}
		},
		ClickedClearFilters: () =>
			navigateFilters(model, search, { range: { kind: "all" }, kind: filters.kind }),
	})
}
