import { AuditActorType, AuditOutcome } from "@maple/domain/http"
import type { V2AuditLogEntry } from "@maple/domain/http/v2"
/** Entries per audit log page. */
const AUDIT_LOG_PAGE_LIMIT = 50
import {
	AUDIT_RANGE_PRESETS,
	type AuditDateRange,
	type AuditLogFilters,
	auditLogSearchFrom,
	parseAuditLogSearch,
} from "../../../components/settings/audit-log-filters"
import { Clock, Effect, Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import { toLoadFailure } from "../../../data/load-failure"
import { isClerkAuthEnabled } from "../../../lib/services/common/auth-mode"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { clerkTry, currentClerkOrganization } from "../../../platform/clerk"
import { memberDisplayName } from "../kit/members"
import { AppRoute, hrefOf } from "../../../route"
import type { SettingsSearch as SettingsSearchSchema } from "../../../route/search"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"
import * as Select from "../../../ui/select"
import { PageOutMessage, type PageReturn } from "../../contract"
import { Message, type Model, PageRequest } from "./model"

type Return = PageReturn<Model, Message>
type SettingsSearch = typeof SettingsSearchSchema.Type

export const ANYONE = "anyone"

const asActorType = Schema.decodeUnknownOption(AuditActorType)
const asOutcome = Schema.decodeUnknownOption(AuditOutcome)

/** The filter input `AuditLogSection` derives from the URL; a rolling preset resolves in the Command. */
export const baseRequestOf = (filters: AuditLogFilters): PageRequest => {
	const range = filters.range
	return {
		...(filters.actorType !== undefined && { actorType: filters.actorType }),
		...(filters.actorId !== undefined && { actorId: filters.actorId }),
		...(filters.outcome !== undefined && { outcome: filters.outcome }),
		...(range.kind === "custom" && range.since !== undefined && { since: range.since }),
		...(range.kind === "custom" && range.until !== undefined && { until: range.until }),
		...(range.kind === "preset" && { preset: range.preset }),
	}
}

const presetMsOf = (range: AuditDateRange): number | null =>
	range.kind === "preset" ? (AUDIT_RANGE_PRESETS.find((preset) => preset.value === range.preset)?.ms ?? null) : null

const sameRequest = (a: PageRequest, b: PageRequest) =>
	a.cursor === b.cursor &&
	a.actorType === b.actorType &&
	a.actorId === b.actorId &&
	a.outcome === b.outcome &&
	a.since === b.since &&
	a.until === b.until &&
	a.preset === b.preset

/** `auditLogPageAtom`: one page, newest first; a preset window resolves against the clock now. */
const FetchAuditPage = Command.define("FetchAuditLogPage", {
	args: { request: PageRequest, presetMs: Schema.NullOr(Schema.Number), resolvedSince: Schema.NullOr(Schema.String) },
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
				...(request.actorType !== undefined && { actor_type: request.actorType }),
				...(request.actorId !== undefined && { actor_id: request.actorId }),
				...(request.outcome !== undefined && { outcome: request.outcome }),
				...(since !== undefined && { since }),
				...(request.until !== undefined && { until: request.until }),
			},
		})
		return { data: response.data, has_more: response.has_more, next_cursor: response.next_cursor }
	}).pipe(
		Effect.mapError(toLoadFailure),
		Effect.result,
		Effect.map((result) => Message.CompletedFetchPage({ request, resolvedSince: presetSince, result })),
	)

/** `useOrganization({ memberships: { pageSize: 100 } })`: members by user id; none on a failed read. */
const FetchAuditMembers = Command.define("FetchAuditLogMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: currentClerkOrganization.pipe(
		Effect.flatMap((organization) => clerkTry("", () => organization.getMemberships({ pageSize: 100 }))),
		Effect.map((page) =>
			page.data.flatMap((membership) => {
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
const fetch = (model: Model, request: PageRequest, search: SettingsSearch, resolvedSince: string | null = null): Return => ({
	// A cursor-less request starts a list; a later page keeps the filters it continues.
	model: { ...model, request, base: request.cursor === undefined ? request : model.base, isWaiting: true, isQuiet: false, failure: null },
	commands: [FetchAuditPage({ request, presetMs: presetMsOf(parseAuditLogSearch(search).range), resolvedSince })],
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
			dateRange: Popover.init("audit-date-range", { align: "start" }),
		},
		baseRequestOf(parseAuditLogSearch(search)),
		search,
	)
	// Self-hosted runs without Clerk: there is no member directory to list.
	return { ...started, commands: [...(started.commands ?? []), ...(isClerkAuthEnabled ? [FetchAuditMembers()] : [])] }
}

/** A filter change (toolbar, shared link, back/forward) restarts the list. */
export const searchChanged = (model: Model, search: SettingsSearch): Return => {
	const base = baseRequestOf(parseAuditLogSearch(search))
	return sameRequest(base, model.base)
		? { model }
		: fetch({ ...model, pinnedUntil: null }, base, search)
}

const dedupeById = (existing: ReadonlyArray<V2AuditLogEntry>, next: ReadonlyArray<V2AuditLogEntry>) => {
	const seen = new Set(existing.map((entry) => entry.id))
	return [...existing, ...next.filter((entry) => !seen.has(entry.id))]
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
	values.includes(value) ? values.filter((entry) => entry !== value) : [...values, value]

/** Back on the tab: its first page reads again behind the list, quietly, as nobody asked for it. */
export const revisit = (model: Model, search: SettingsSearch): Return => {
	const filters = parseAuditLogSearch(search)
	const request = baseRequestOf(filters)
	// The same first page still in flight answers it: a second read could land out of order.
	if (model.isWaiting && sameRequest(request, model.request)) return { model }
	return {
		model: { ...model, request, base: request, pinnedUntil: null, isWaiting: true, isQuiet: model.view !== null, failure: null },
		commands: [FetchAuditPage({ request, presetMs: presetMsOf(filters.range), resolvedSince: null })],
	}
}

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
							entries: request.cursor === undefined ? page.data : dedupeById(model.view?.entries ?? [], page.data),
							hasMore: page.has_more,
							nextCursor: page.next_cursor,
						},
					},
				}),
				onFailure: (failure) => ({ model: { ...model, resolvedSince, isWaiting: false, isQuiet: false, failure } }),
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
				{ ...baseRequestOf(filters), cursor: view.nextCursor, ...(pinnedUntil !== null && { until: pinnedUntil }) },
				search,
				model.resolvedSince,
			)
		},
		ToggledEntry: ({ id }) => ({ model: { ...model, expanded: toggled(model.expanded, id) } }),
		GotCopyMessage: ({ key, message: child }) => {
			const step = CopyButton.update(model.copies[key] ?? CopyButton.init(), child)
			return {
				model: { ...model, copies: { ...model.copies, [key]: step.model } },
				commands: Command.mapMessages(step.commands, (inner) => Message.GotCopyMessage({ key, message: inner })),
			}
		},
		ClickedActorType: ({ value }) =>
			navigateFilters(model, search, { ...filters, actorType: Option.getOrUndefined(asActorType(value)) }),
		ClickedOutcome: ({ value }) =>
			navigateFilters(model, search, { ...filters, outcome: Option.getOrUndefined(asOutcome(value)) }),
		GotPersonSelectMessage: ({ message: child }) => {
			const step = Select.update(model.personSelect, child)
			const lifted: Return = {
				model: { ...model, personSelect: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotPersonSelectMessage({ message: inner })),
			}
			if (step.outMessage === undefined) return lifted
			const actorId = step.outMessage.value === ANYONE ? undefined : step.outMessage.value
			return { ...lifted, outMessage: navigateFilters(lifted.model, search, { ...filters, actorId }).outMessage }
		},
		GotDateRangeMessage: ({ message: child }) => {
			const step = Popover.update(model.dateRange, child)
			return {
				model: { ...model, dateRange: step.model },
				commands: Command.mapMessages(step.commands ?? [], (inner) => Message.GotDateRangeMessage({ message: inner })),
			}
		},
		ClickedRangePreset: ({ value }) => {
			const preset = AUDIT_RANGE_PRESETS.find((option) => option.value === value)
			const closed = Popover.close(model.dateRange)
			const range: AuditDateRange = preset === undefined ? { kind: "all" } : { kind: "preset", preset: preset.value }
			return {
				...navigateFilters({ ...model, dateRange: closed.model }, search, { ...filters, range }),
				commands: Command.mapMessages(closed.commands ?? [], (inner) => Message.GotDateRangeMessage({ message: inner })),
			}
		},
		ClickedClearFilters: () => navigateFilters(model, search, { range: { kind: "all" } }),
	})
}
