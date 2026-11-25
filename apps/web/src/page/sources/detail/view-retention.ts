import type { V2RetentionPolicy, V2Source } from "@maple/domain/http/v2"
import type { RetentionSignal } from "@maple/domain/retention"
import { Array as Arr, Option } from "effect"
import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { errorState } from "@maple/views/ui/error-state"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { settingRow } from "@maple/views/ui/setting-row"
import { skeletonList } from "@maple/views/ui/skeleton"
import { typography } from "@maple/views/ui/typography"
import {
	changeSentence,
	periodLabel,
	periodOptions,
	SIGNAL_DESCRIPTIONS,
	SIGNAL_LABELS,
} from "../../kit/retention"
import { gatedControl } from "../../kit/session-grants"
import { sectionNote, settingsSection } from "../../kit/settings-section"
import { Message } from "./message"
import type { Model, RetentionForm, RetentionSet } from "./model"
import { effectiveDays, INHERIT, signalsOf, storedSet } from "./retention"

type H = HtmlBuilder<Message>

export type Clock = Readonly<{ nowMs: number; timeZone: string }>

const rowDescription = (
	h: H,
	policy: V2RetentionPolicy,
	stored: RetentionSet,
	draft: RetentionSet,
	signal: RetentionSignal,
	clock: Clock,
	sourceId: string,
): Html => {
	const from = effectiveDays(policy, stored, signal)
	const to = effectiveDays(policy, draft, signal)
	const edit = { _tag: "Source", sourceId, days: draft[signal] } as const
	const sentence = changeSentence(policy, signal, { from, to, edit }, clock.nowMs, clock.timeZone)
	return sentence === null
		? typography(h, { size: "sm", tone: "muted", className: "font-prose" }, [SIGNAL_DESCRIPTIONS[signal]])
		: typography(h, { size: "sm", tone: "foreground", className: "font-prose" }, [sentence])
}

const signalRow = (
	h: H,
	model: Model,
	form: RetentionForm,
	policy: V2RetentionPolicy,
	stored: RetentionSet,
	draft: RetentionSet,
	signal: RetentionSignal,
	clock: Clock,
): Html => {
	const id = `source-retention-${signal}`
	const own = draft[signal]
	return settingRow(h, {
		ids: { control: id, label: `${id}-label`, description: `${id}-description` },
		label: SIGNAL_LABELS[signal],
		description: rowDescription(h, policy, stored, draft, signal, clock, model.sourceId ?? ""),
		className: "p-4",
		control: [
			gatedControl(h, { grants: model.grants ?? [] }, "retention:manage", (isDisabled) =>
				nativeSelect(
					h,
					{
						size: "sm",
						className: "w-48",
						value: own === null ? INHERIT : String(own),
						isDisabled: isDisabled || form.isSaving,
						attributes: [
							h.Id(id),
							h.AriaDescribedBy(`${id}-description`),
							h.OnChange((value) => Message.ChangedRetentionPeriod({ signal, value })),
						],
					},
					[
						nativeOption(
							INHERIT,
							`Organization (${periodLabel(policy.organization.days[signal])})`,
						),
						...Arr.map(periodOptions(), (option) => nativeOption(option.value, option.label)),
					],
				),
			),
		],
	})
}

export const OWN_WAREHOUSE_NOTE =
	"Your organization's own ClickHouse keeps its own retention, so periods set here do not apply."

/** How long this source keeps each signal it can send, against the organization's periods. */
export const retentionSection = (h: H, model: Model, source: V2Source, clock: Clock): Html => {
	const form = model.retention
	const signals = signalsOf(source)
	return settingsSection(
		h,
		{
			id: "source-settings-retention",
			title: "Retention",
			description: [
				"How long this source keeps each signal. Follow the organization, or keep a signal shorter or longer.",
			],
			padded: false,
		},
		form === null
			? []
			: [
					Option.match(
						Option.all({
							policy: AsyncData.getData(form.policy),
							draft: Option.fromNullishOr(form.draft),
						}),
						{
							onSome: ({ policy, draft }) => {
								if (policy.storage === "own_warehouse")
									return sectionNote(h, OWN_WAREHOUSE_NOTE)
								const stored = storedSet(policy, source.id)
								return h.div(
									[h.Class("divide-y")],
									Arr.map(signals, (signal) =>
										signalRow(h, model, form, policy, stored, draft, signal, clock),
									),
								)
							},
							onNone: () =>
								AsyncData.isFailure(form.policy)
									? errorState(h, {
											failure: form.policy.error,
											title: "Couldn't load retention",
											variant: "row",
											onRetry: Message.ClickedRetryRetention(),
										})
									: skeletonList(h, {
											rows: signals.length,
											label: "Loading retention",
											className: "p-4",
										}),
						},
					),
				],
	)
}
