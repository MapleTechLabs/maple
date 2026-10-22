import { getMetricsAggregations, type QueryBuilderMetricType } from "@maple/query-engine/query-builder"
import { cn } from "@maple/ui/lib/utils"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "../../../lib/query-builder/where-clause-highlight"
import { Option } from "effect"
import { AsyncData as FoldkitAsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import type * as Combobox from "../../../ui/combobox"
import { view as comboboxView } from "../../../ui/combobox-view"
import * as CopyButton from "../../../ui/copy-button"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import { panel } from "../../../ui/panel"
import type * as Select from "../../../ui/select"
import { view as selectView } from "../../../ui/select-view"
import { textarea } from "../../../ui/textarea"
import { SERVICE_KEY } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { GROUP_BY_NONE_LABEL } from "./update"
import { whereAutocompleteOf } from "./update-where"
import { isOpenOf } from "./where-editor"
import { suggestionListbox, whereKeyHandler } from "../../kit/where-autocomplete-view"
import { MountKeepWhereFocus, MountWhereCaret } from "./command"

// `MetricGraduationActions` and `MetricQueryControls` (components/metrics/).

type H = HtmlBuilder<Message>

const label = (h: H, text: string): Html =>
	h.span([h.Class("text-xs text-muted-foreground shrink-0")], [text])

/** The explorer's way out: a dashboard widget, an alert rule, or a shared link. */
export const graduationActions = (h: H, model: Model): Html =>
	h.div(
		[h.Class("flex justify-end")],
		[
			h.div(
				[h.Class("flex items-center gap-2")],
				[
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedAddToDashboard())],
						},
						[icon(h, "GridSquareCirclePlusIcon"), "Add to dashboard"],
					),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							attributes: [h.OnClick(Message.ClickedCreateAlert())],
						},
						[icon(h, "BellIcon"), "Create alert"],
					),
					CopyButton.copyButton(h, {
						status: model.copyLink.status,
						label: "Link",
						idleLabel: "Copy link",
						idleIcon: "LinkIcon",
						variant: "outline",
						onClick: Message.ClickedCopyLink(),
					}),
				],
			),
		],
	)

const toAggregation = (message: Select.Message) => Message.GotAggregationSelectMessage({ message })
const toGroupBy = (message: Combobox.Message) => Message.GotGroupByComboboxMessage({ message })

/** `WhereClauseEditor`: the textarea with its syntax-highlight overlay. */
const whereKey = (isOpen: boolean) =>
	whereKeyHandler<Message>(isOpen, {
		enter: Message.PressedWhereEnterOnList(),
		move: (step) => Message.MovedWhereSuggestion({ step }),
		tab: Message.PressedWhereTab(),
		dismiss: Message.DismissedWhereSuggestions(),
	})

const suggestionList = (
	h: H,
	model: Model,
	suggestions: ReturnType<typeof whereAutocompleteOf>["suggestions"],
): Html =>
	suggestionListbox(h, {
		suggestions,
		activeIndex: model.whereEditor.activeIndex,
		anchor: model.whereEditor.anchor,
		onApply: (index) => Message.AppliedWhereSuggestion({ index }),
		keepFocus: h.OnMount(MountKeepWhereFocus()),
	})

const whereEditor = (h: H, model: Model): Html => {
	const autocomplete = whereAutocompleteOf(model)
	const isOpen = isOpenOf(model.whereEditor, autocomplete)
	const isHighlighting = model.whereInput.length > 0
	const textareaClassName = "min-h-8 resize-y text-xs"
	return h.div(
		[h.Class("relative flex-1")],
		[
			textarea(h, {
				id: "metric-where-clause",
				className: cn(textareaClassName, isHighlighting && "text-transparent caret-foreground"),
				defaultValue: model.whereInput,
				attributes: [
					h.AriaLabel(`Where clause for ${model.metricName}`),
					h.Placeholder('http.route = "/api/users"'),
					h.Rows(1),
					h.OnInput((value) => Message.ChangedWhereInput({ value })),
					h.OnKeyDownPreventDefault(whereKey(isOpen)),
					h.OnMount(MountWhereCaret()),
				],
			}),
			...(isHighlighting
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(
									cn(
										"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
										textareaClassName,
									),
								),
							],
							[
								h.div(
									[
										h.Class(
											"px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] break-words whitespace-pre-wrap",
										),
									],
									tokenizeWhereClause(model.whereInput).map((token) =>
										h.span(
											[h.Style({ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] })],
											[token.text],
										),
									),
								),
							],
						),
					]
				: []),
			...(isOpen ? [suggestionList(h, model, autocomplete.suggestions)] : []),
		],
	)
}

/** `useMetricScopedAutocomplete`'s group-by keys: the metric's own attribute keys. */
const scopedKeys = (model: Model): ReadonlyArray<string> =>
	Option.match(FoldkitAsyncData.getData(model.attributeKeys.data), {
		onNone: () => [],
		onSome: (rows) => rows.map((row) => row.attributeKey),
	})

/** The structured query row: aggregation, where, group-by, step. */
export const queryControls = (
	h: H,
	model: Model,
	metricType: QueryBuilderMetricType,
	isMonotonic: boolean,
): Html =>
	panel(h, { className: "flex-row flex-wrap items-start gap-x-4 gap-y-2 p-3" }, [
		h.submodel({
			slotId: "metric-aggregation",
			model: model.aggregationSelect,
			view: selectView,
			toParentMessage: toAggregation,
			viewInputs: {
				entries: getMetricsAggregations(metricType, isMonotonic).map((option) => ({
					_tag: "Item" as const,
					item: { value: option.value, label: option.label },
				})),
				size: "sm",
				className: "w-28 text-xs",
				toView: (parts) =>
					h.div([h.Class("flex items-center gap-2")], [label(h, "Aggregate"), ...parts]),
			},
		}),
		h.div(
			[h.Class("flex min-w-64 flex-1 items-center gap-2")],
			[label(h, "Where"), whereEditor(h, model)],
		),
		h.submodel({
			slotId: "metric-group-by",
			model: model.groupByCombobox,
			view: comboboxView,
			toParentMessage: toGroupBy,
			viewInputs: {
				items: [GROUP_BY_NONE_LABEL, SERVICE_KEY, ...scopedKeys(model).map((key) => `attr.${key}`)],
				placeholder: "Search fields...",
				emptyText: "",
				className: "h-8 w-52 text-xs",
				toView: ({ field, rest }) =>
					h.div([h.Class("flex items-center gap-2")], [label(h, "Group by"), field, ...rest]),
			},
		}),
		h.div(
			[h.Class("flex items-center gap-2")],
			[
				label(h, "Every"),
				input(h, {
					id: "metric-step-interval",
					className: "h-8 w-20 text-xs",
					attributes: [
						h.AriaLabel("Step interval"),
						h.Placeholder("Auto"),
						h.Value(model.stepInput),
						h.OnInput((value) => Message.ChangedStepInput({ value })),
						h.OnBlur(Message.CommittedStepInput()),
						h.OnKeyDownPreventDefault((key) =>
							key === "Enter" ? Option.some(Message.CommittedStepInput()) : Option.none(),
						),
					],
				}),
				h.span([h.Class("text-xs text-muted-foreground")], ["sec"]),
			],
		),
	])
