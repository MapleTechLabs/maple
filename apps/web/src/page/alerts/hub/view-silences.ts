import type { V2AlertSilence } from "@maple/domain/http/v2"
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
import { skeleton } from "@maple/views/ui/skeleton"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { sectionHeading } from "../../kit/section-heading"
import {
	endsAtMs,
	formatSilenceTime,
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
			: `Ended ${end}`
}

const silenceRow = (
	h: H,
	model: Model,
	silence: V2AlertSilence,
	options: Readonly<{ nowMs: number; timeZone: string; ruleName: (id: string) => string }>,
): Html => {
	const status = silenceStatusAt(silence, options.nowMs)
	const isEnding = model.endingSilenceIds.includes(silence.id)
	return listRow(h, {
		divided: true,
		leading: icon(h, "BellSlashIcon", { size: 16 }),
		title: silence.reason,
		meta: Arr.join(
			[
				windowText(silence, options.nowMs, options.timeZone),
				...silenceScopeParts(silence.matchers, options.ruleName),
			],
			" · ",
		),
		trailing:
			status !== "ended" && canManage(model)
				? [
						button(
							h,
							{
								size: "sm",
								variant: "outline",
								isDisabled: isEnding,
								attributes: [h.OnClick(Message.ClickedEndSilence({ silenceId: silence.id }))],
							},
							[status === "scheduled" ? "Cancel" : "End now"],
						),
					]
				: status === "ended"
					? [badge(h, { variant: "outline" }, ["Ended"])]
					: [],
	})
}

const section = (
	h: H,
	model: Model,
	title: string,
	silences: ReadonlyArray<V2AlertSilence>,
	options: Readonly<{ nowMs: number; timeZone: string; ruleName: (id: string) => string }>,
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

const loaded = (
	h: H,
	model: Model,
	silences: ReadonlyArray<V2AlertSilence>,
	nowMs: number,
	timeZone: string,
): Html => {
	const rules = model.rules ?? []
	const ruleName = (id: string) =>
		Option.getOrElse(
			Option.map(
				Arr.findFirst(rules, (rule) => rule.id === id),
				(rule) => rule.name,
			),
			() => (model.rules === null ? "rule" : "deleted rule"),
		)
	const byStatus = (status: V2AlertSilence["status"]) =>
		Arr.filter(silences, (silence) => silenceStatusAt(silence, nowMs) === status)
	const ended = Arr.filter(byStatus("ended"), (silence) => endsAtMs(silence) > nowMs - ENDED_VISIBLE_MS)
	const active = byStatus("active")
	const scheduled = byStatus("scheduled")
	if (active.length + scheduled.length + ended.length === 0) return silencesEmptyState(h)
	const options = { nowMs, timeZone, ruleName }
	return vstack(h, { gap: "6" }, [
		...section(h, model, "Active", active, options),
		...section(h, model, "Scheduled", scheduled, options),
		...section(h, model, "Ended in the last 7 days", ended, options),
		...(active.length === 0
			? [typography(h, { size: "xs", tone: "muted" }, ["Nothing is silenced right now"])]
			: []),
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
