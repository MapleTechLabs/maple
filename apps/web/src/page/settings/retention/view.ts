import * as Policy from "@maple/domain/policy"
import type { V2RetentionDays, V2RetentionPolicy } from "@maple/domain/http/v2"
import { RETENTION_SIGNALS, type RetentionSignal } from "@maple/domain/retention"
import { AsyncData, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { errorState } from "@maple/views/ui/error-state"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { settingRow } from "@maple/views/ui/setting-row"
import { skeletonList } from "@maple/views/ui/skeleton"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr, Option } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import { saveBar } from "../../kit/save-bar"
import { gatedControl } from "../../kit/session-grants"
import { docsLink } from "../../kit/signal-empty-state"
import { adminOnlyNote, sectionNote, settingsSection, settingsSections } from "../../kit/settings-section"
import {
	changeSentence,
	periodLabel,
	periodOptions,
	SIGNAL_DESCRIPTIONS,
	SIGNAL_LABELS,
} from "../../kit/retention"
import { sourceHrefById } from "../../sources/kit/shared"
import { canManage, Message, type Model } from "./model"
import { changedSignals } from "./update"

type H = HtmlBuilder<Message>

export type Inputs = Readonly<{ nowMs: number; timeZone: string }>

/** How many sources keep `signal` for a period of their own. */
const overridingSources = (policy: V2RetentionPolicy, signal: RetentionSignal): number =>
	Arr.filter(policy.sources, (source) => source.set[signal] !== null).length

const rowDescription = (
	h: H,
	policy: V2RetentionPolicy,
	draft: V2RetentionDays,
	signal: RetentionSignal,
	inputs: Inputs,
): Html => {
	const from = policy.organization.days[signal]
	const to = draft[signal]
	const edit = { _tag: "Organization", days: to } as const
	const sentence = changeSentence(policy, signal, { from, to, edit }, inputs.nowMs, inputs.timeZone)
	if (sentence !== null)
		return typography(h, { size: "sm", tone: "foreground", className: "font-prose" }, [sentence])
	const overriding = overridingSources(policy, signal)
	return typography(h, { size: "sm", tone: "muted", className: "font-prose" }, [
		SIGNAL_DESCRIPTIONS[signal],
		...(overriding === 0
			? []
			: [
					` ${overriding === 1 ? "1 source keeps its" : `${overriding} sources keep their`} own period.`,
				]),
	])
}

const signalRow = (
	h: H,
	model: Model,
	policy: V2RetentionPolicy,
	draft: V2RetentionDays,
	signal: RetentionSignal,
	inputs: Inputs,
): Html => {
	const id = `retention-${signal}`
	return settingRow(h, {
		ids: { control: id, label: `${id}-label`, description: `${id}-description` },
		label: SIGNAL_LABELS[signal],
		description: rowDescription(h, policy, draft, signal, inputs),
		className: "p-4",
		control: [
			gatedControl(h, model, "retention:manage", (isDisabled) =>
				nativeSelect(
					h,
					{
						size: "sm",
						className: "w-40",
						value: String(draft[signal]),
						isDisabled: isDisabled || model.isSaving,
						attributes: [
							h.Id(id),
							h.AriaDescribedBy(`${id}-description`),
							h.OnChange((value) => Message.ChangedPeriod({ signal, value })),
						],
					},
					Arr.map(periodOptions(policy.defaults[signal]), (option) =>
						nativeOption(option.value, option.label),
					),
				),
			),
		],
	})
}

/** An org on its own ClickHouse keeps that cluster's retention; nothing here would apply. */
const ownWarehouseNotice = (h: H): Html =>
	alert(h, { variant: "info", role: "status", className: "m-4 w-auto" }, [
		alertTitle(h, ["Your ClickHouse keeps its own retention"]),
		alertDescription(h, [
			"Telemetry is stored in your organization's own ClickHouse, so it is kept for as long as the tables there say. ",
			textLink(h, { href: hrefOf(AppRoute.Settings({ search: { tab: "data-platform" } })) }, [
				"Data platform",
			]),
		]),
	])

const signalsSection = (h: H, model: Model, inputs: Inputs): Html =>
	settingsSection(
		h,
		{
			id: "settings-retention-signals",
			title: "Organization",
			description: [
				"How long Maple keeps each signal. Data keeps the period in force when it arrived, and each change says what it does before you save.",
			],
			padded: false,
		},
		[
			Option.match(
				Option.all({
					policy: AsyncData.getData(model.policy),
					draft: Option.fromNullishOr(model.draft),
				}),
				{
					onSome: ({ policy, draft }) =>
						policy.storage === "own_warehouse"
							? ownWarehouseNotice(h)
							: h.div(
									[h.Class("divide-y")],
									Arr.map(RETENTION_SIGNALS, (signal) =>
										signalRow(h, model, policy, draft, signal, inputs),
									),
								),
					onNone: () =>
						AsyncData.isFailure(model.policy)
							? errorState(h, {
									failure: model.policy.error,
									title: "Couldn't load retention",
									variant: "row",
									onRetry: Message.ClickedRetry(),
								})
							: skeletonList(h, {
									rows: RETENTION_SIGNALS.length,
									label: "Loading retention",
									className: "p-4",
								}),
				},
			),
		],
	)

const sourceName = (model: Model, id: string): string =>
	Option.getOrElse(
		Option.map(
			Arr.findFirst(model.sourceNames ?? [], (source) => source.id === id),
			(source) => source.name,
		),
		() => "A source",
	)

/** "Logs 6 months, traces 1 week". */
const overrideSummary = (set: V2RetentionPolicy["sources"][number]["set"]): string =>
	Arr.join(
		Arr.flatMap(RETENTION_SIGNALS, (signal) => {
			const days = set[signal]
			return days === null ? [] : [`${SIGNAL_LABELS[signal]} ${periodLabel(days)}`]
		}),
		", ",
	)

const sourcesSection = (h: H, model: Model): ReadonlyArray<Html> =>
	Option.match(AsyncData.getData(model.policy), {
		onNone: () => [],
		onSome: (policy) => [
			settingsSection(
				h,
				{
					id: "settings-retention-sources",
					title: "Sources with their own period",
					description: [
						"A source can keep a signal shorter or longer than the organization, from its Settings tab. Reads reach as far back as the longest of them.",
					],
					padded: false,
				},
				[
					policy.sources.length === 0
						? sectionNote(h, "Every source keeps the organization's periods.")
						: h.div(
								[h.Class("divide-y")],
								Arr.map(policy.sources, (source) =>
									hstack(
										h,
										{
											gap: "3",
											justify: "between",
											className: "p-4",
											attributes: [h.Key(source.source_id)],
										},
										[
											// A source's settings need Manage sources; without it the name is plain text.
											Policy.can(model.grants, "sources:manage")
												? textLink(
														h,
														{
															href: sourceHrefById(
																source.source_id,
																"settings",
															),
														},
														[sourceName(model, source.source_id)],
													)
												: typography(h, { size: "sm" }, [
														sourceName(model, source.source_id),
													]),
											typography(h, { size: "sm", tone: "muted", truncate: true }, [
												overrideSummary(source.set),
											]),
										],
									),
								),
							),
				],
			),
		],
	})

const footnote = (h: H): Html =>
	vstack(h, { gap: "2" }, [
		typography(h, { size: "xs", tone: "muted", className: "font-prose" }, [
			"Hourly rollups behind service charts and the service map keep 12 months, whatever is set here. ",
			docsLink(h, "retention", "How retention works"),
		]),
	])

export const view = Submodel.defineView<Model, Message, Inputs>((model, inputs, h) =>
	settingsSections(h, [
		...(canManage(model)
			? []
			: [
					adminOnlyNote(h, [
						"Only people with Manage retention can change these periods. Admin has it.",
					]),
				]),
		signalsSection(h, model, inputs),
		...sourcesSection(h, model),
		footnote(h),
		...saveBar(h, {
			isDirty: changedSignals(model).length > 0,
			isPending: model.isSaving,
			changeCount: changedSignals(model).length,
			onDiscard: Message.ClickedDiscard(),
			onSave: Message.ClickedSave(),
		}),
	]),
)
