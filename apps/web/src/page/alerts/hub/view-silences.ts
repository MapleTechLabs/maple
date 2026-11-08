import type { AlertMaintenanceWindowId } from "@maple/domain/http"
import type { V2AlertMaintenanceWindow, V2AlertSilence } from "@maple/domain/http/v2"
import { Option, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { button } from "@maple/views/ui/button"
import { empty, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/views/ui/empty"
import { errorState } from "@maple/views/ui/error-state"
import { icon } from "@maple/views/ui/icon"
import { listRow } from "@maple/views/ui/list-row"
import { panel } from "@maple/views/ui/panel"
import { removableChip } from "@maple/views/ui/removable-chip"
import { skeleton } from "@maple/views/ui/skeleton"
import { hstack, vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { sectionHeading } from "../../kit/section-heading"
import { windowIdOfParam } from "../shared/maintenance-windows"
import {
	endsAtMs,
	formatSilenceTime,
	isCancelledSilence,
	silenceScopeParts,
	silenceStatusAt,
	startsAtMs,
} from "../shared/silences"
import { Message } from "./message"
import { canManage, type Model } from "./model"

// The Silences tab: what is silenced now, what is scheduled, and what ended recently.

type H = HtmlBuilder<Message>

/** Ended silences stay listed for a week, so a recent maintenance window is still visible. */
const ENDED_VISIBLE_MS = 7 * 24 * 60 * 60_000

const silencesEmptyState = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "BellSlashIcon", { size: 18 })]),
				emptyTitle(h, ["No silences"]),
				emptyDescription(h, [
					"Silence a rule, a service or an environment during a deploy or a planned migration. Rules keep checking and incidents still open, but no one is paged.",
				]),
			]),
		],
		"py-12",
	)

const windowText = (silence: V2AlertSilence, nowMs: number, timeZone: string): string => {
	const status = silenceStatusAt(silence, nowMs)
	const start = formatSilenceTime(startsAtMs(silence), nowMs, timeZone)
	const end = formatSilenceTime(endsAtMs(silence), nowMs, timeZone)
	return status === "active"
		? `Until ${end}`
		: status === "scheduled"
			? `${start} to ${end}`
			: isCancelledSilence(silence)
				? `Cancelled ${end}`
				: `Ended ${end}`
}

const silenceRow = (
	h: H,
	model: Model,
	silence: V2AlertSilence,
	options: Readonly<{
		nowMs: number
		timeZone: string
		ruleName: (id: string) => string
		rulesLoaded: boolean
		windowName: (id: AlertMaintenanceWindowId) => string
	}>,
): Html => {
	const status = silenceStatusAt(silence, options.nowMs)
	const isEnding = model.endingSilenceIds.includes(silence.id)
	return listRow(h, {
		divided: true,
		leading: icon(h, "BellSlashIcon", { size: 16 }),
		title: h.span([h.Title(silence.reason)], [silence.reason]),
		meta: Arr.join(
			[
				windowText(silence, options.nowMs, options.timeZone),
				// Rule names wait for the rules to sync rather than read as a bare "rule".
				...silenceScopeParts(
					options.rulesLoaded ? silence.matchers : { ...silence.matchers, rule_ids: [] },
					options.ruleName,
				),
				// Until rules sync, a rule-scoped silence still says it covers rules.
				...(options.rulesLoaded || (silence.matchers.rule_ids ?? []).length === 0
					? []
					: [
							(silence.matchers.rule_ids ?? []).length === 1
								? "1 rule"
								: `${(silence.matchers.rule_ids ?? []).length} rules`,
						]),
			],
			" · ",
		),
		trailing:
			// A maintenance window owns its silences; they end or change only through the window.
			status !== "ended" && silence.maintenance_window_id !== null
				? [
						badge(
							h,
							{
								variant: "outline",
								attributes: [h.Title("Change it from the Maintenance tab")],
							},
							[
								icon(h, "CalendarIcon"),
								typography(h, { as: "span", truncate: true, className: "min-w-0 max-w-40" }, [
									`Managed by ${options.windowName(silence.maintenance_window_id)}`,
								]),
							],
						),
					]
				: status !== "ended" && canManage(model)
					? [
							button(
								h,
								{
									size: "sm",
									variant: "outline",
									isDisabled: isEnding,
									attributes: [
										h.OnClick(Message.ClickedEndSilence({ silenceId: silence.id })),
									],
								},
								[status === "scheduled" ? "Cancel" : "End now"],
							),
						]
					: status === "ended"
						? [
								badge(h, { variant: "outline" }, [
									isCancelledSilence(silence) ? "Cancelled" : "Ended",
								]),
							]
						: [],
	})
}

const section = (
	h: H,
	model: Model,
	title: string,
	silences: ReadonlyArray<V2AlertSilence>,
	options: Readonly<{
		nowMs: number
		timeZone: string
		ruleName: (id: string) => string
		rulesLoaded: boolean
		windowName: (id: AlertMaintenanceWindowId) => string
	}>,
): ReadonlyArray<Html> =>
	silences.length === 0
		? []
		: [
				vstack(h, { gap: "2" }, [
					sectionHeading(h, { title, count: String(silences.length) }),
					panel(
						h,
						{},
						Arr.map(silences, (silence) => silenceRow(h, model, silence, options)),
					),
				]),
			]

/** A window's name; "a maintenance window" until the windows load, or once it is deleted. */
const nameOfWindow = (
	windows: ReadonlyArray<V2AlertMaintenanceWindow>,
	id: AlertMaintenanceWindowId,
): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(windows, (window) => window.id === id),
			(window) => window.name,
		),
		() => "a maintenance window",
	)

const windowOccurrencesEmpty = (h: H): Html =>
	empty(
		h,
		[
			emptyHeader(h, [
				emptyMedia(h, { variant: "icon" }, [icon(h, "CalendarIcon", { size: 18 })]),
				emptyTitle(h, ["No occurrences listed"]),
				emptyDescription(h, [
					"Each occurrence is written as a silence up to 48 hours before it starts, and stays listed for a week after it ends.",
				]),
			]),
		],
		"py-12",
	)

const loaded = (
	h: H,
	model: Model,
	silences: ReadonlyArray<V2AlertSilence>,
	nowMs: number,
	timeZone: string,
): Html => {
	const rules = model.rules ?? []
	const ruleName = (id: string): string =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(rules, (rule) => rule.id === id),
				(rule) => rule.name,
			),
			() => "deleted rule",
		)
	const windows = Option.getOrElse(AsyncData.getData(model.windows.data), () => [])
	const windowName = (id: AlertMaintenanceWindowId): string => nameOfWindow(windows, id)
	const filter = windowIdOfParam(model.search.window)
	const shown = Option.match(filter, {
		onNone: () => silences,
		onSome: (id) => Arr.filter(silences, (silence) => silence.maintenance_window_id === id),
	})
	const byStatus = (status: V2AlertSilence["status"]) =>
		Arr.filter(shown, (silence) => silenceStatusAt(silence, nowMs) === status)
	const ended = Arr.filter(byStatus("ended"), (silence) => endsAtMs(silence) > nowMs - ENDED_VISIBLE_MS)
	const active = byStatus("active")
	const scheduled = byStatus("scheduled")
	const chip = Option.map(filter, (id) =>
		hstack(h, { gap: "2", wrap: true }, [
			removableChip(h, {
				label: `Window: ${windowName(id)}`,
				onRemove: Message.ClickedClearWindowFilter(),
			}),
		]),
	)
	if (active.length + scheduled.length + ended.length === 0)
		return Option.match(chip, {
			onNone: () => silencesEmptyState(h),
			onSome: (row) => vstack(h, { gap: "4" }, [row, windowOccurrencesEmpty(h)]),
		})
	const options = { nowMs, timeZone, ruleName, rulesLoaded: model.rules !== null, windowName }
	return vstack(h, { gap: "6" }, [
		...Option.toArray(chip),
		...(active.length === 0
			? [typography(h, { size: "xs", tone: "muted" }, ["Nothing is silenced right now"])]
			: []),
		...section(h, model, "Active", active, options),
		...section(h, model, "Scheduled", scheduled, options),
		...section(h, model, "Ended or cancelled in the last 7 days", ended, options),
	])
}

export const silencesTab = (h: H, model: Model, nowMs: number, timeZone: string): Html => {
	const data = model.silences.data
	if (AsyncData.isFailure(data))
		return errorState(h, {
			failure: data.error,
			title: "Couldn't load silences",
			onRetry: Message.ClickedRetrySilences(),
			className: "py-12",
		})
	return Option.match(AsyncData.getData(data), {
		onNone: () => vstack(h, { gap: "4" }, [skeleton(h, "h-6 w-40"), skeleton(h, "h-40 w-full")]),
		onSome: (silences) => loaded(h, model, silences, nowMs, timeZone),
	})
}
