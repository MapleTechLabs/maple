import { cn } from "@maple/ui/lib/utils"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import * as Tooltip from "@maple/views/ui/tooltip"
import { button } from "@maple/views/ui/button"
import { field, fieldErrorText, fieldLabel, type FieldState } from "@maple/views/ui/field"
import { inlineCode } from "@maple/views/ui/inline-code"
import { input } from "@maple/views/ui/input"
import { sqlEditor } from "@maple/views/ui/sql-editor"
import { Message } from "./message"
import type { Model } from "./model"
import { isRunnableSql, type RawSqlState, rawSqlErrorOf, rawSqlIssueOf } from "./raw-sql"
import { SQL_TEXTAREA_ID } from "./sql-step"
import { widgetOf } from "./update"
import { typography } from "@maple/views/ui/typography"
import { hstack } from "@maple/views/ui/stack"
import { SQL_MACRO_HINTS, sqlPanelHeader } from "../../kit/query-builder/sql-panel"
import { Array as Arr, Option } from "effect"
import { stripClass } from "@maple/views/ui/rule"

type H = HtmlBuilder<Message>

/** The tooltip trigger id of a chip, by position (variable names are free text). */
const chipTriggerId = (index: number): string => `widget-sql-chip-${index}`

const CHIP = "h-auto rounded-sm px-2 py-0.5 font-mono text-2xs sm:h-auto sm:text-2xs"

const header = (h: H, rawSql: RawSqlState): Html =>
	sqlPanelHeader(h, {
		isCollapsed: rawSql.isCollapsed,
		issue: rawSqlIssueOf(rawSql),
		toggled: Message.ToggledSqlCollapsed(),
	})

const editor = (h: H, sql: string): Html =>
	sqlEditor(h, {
		id: SQL_TEXTAREA_ID,
		label: "SQL query",
		value: sql,
		onInput: (value) => Message.ChangedSql({ value }),
	})

const chip = (h: H, token: string, className: string, trigger: ReadonlyArray<ChildAttribute>): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "xs",
			className: cn(className, CHIP),
			attributes: [...trigger, h.OnClick(Message.ClickedSqlToken({ token }))],
		},
		[token],
	)

/** What a chip's tooltip says: the macro's expansion, or how a variable expands. */
const chipDescription = (chips: ReadonlyArray<readonly [string, string]>, triggerId: string): string =>
	Arr.findFirst(chips, (_, index) => chipTriggerId(index) === triggerId).pipe(
		Option.flatMapNullishOr((found) => found[1]),
		Option.getOrElse(() => ""),
	)

const IDLE: FieldState = {
	isInvalid: false,
	isDirty: false,
	isFilled: false,
	isFocused: false,
	isTouched: false,
}
const BUCKET_IDS = {
	control: "widget-editor-sql-bucket",
	label: "widget-editor-sql-bucket-label",
	error: "widget-editor-sql-bucket-error",
}

/** The chips, each a trigger of the one description tooltip. */
const chipRow = (
	h: H,
	chips: ReadonlyArray<readonly [string, string]>,
	trigger: (id: string) => ReadonlyArray<ChildAttribute>,
): Html =>
	hstack(
		h,
		{ gap: "1.5", align: "stretch", wrap: true, grow: true, className: "pt-2" },
		Arr.map(chips, ([token], index) =>
			chip(
				h,
				token,
				index < SQL_MACRO_HINTS.length
					? "bg-surface-sunken text-muted-foreground hover:bg-surface-strong active:bg-surface-strong hover:text-foreground active:text-foreground"
					: "bg-primary-a2 text-primary hover:bg-primary-a3 active:bg-primary-a3",
				trigger(chipTriggerId(index)),
			),
		),
	)

/** The macro chips, a chip per dashboard variable, and the bucket override. */
const footer = (h: H, model: Model, rawSql: RawSqlState): Html => {
	const variables = model.document?.variables ?? []
	const chips = [
		...SQL_MACRO_HINTS,
		...Arr.map(
			variables,
			(variable) =>
				[
					`$${variable.name}`,
					`Dashboard variable: expands to the selected value, e.g. ServiceName IN ($${variable.name}). "All" expands to every value.`,
				] as const,
		),
	]
	// The portal sits after the row in block flow, so its brief in-place render moves no chip.
	return h.submodel({
		slotId: "widget-sql-chip-tooltip",
		model: model.sqlChipTooltip,
		view: Tooltip.view,
		toParentMessage: (message) => Message.GotSqlChipTooltipMessage({ message }),
		viewInputs: {
			triggerIds: Arr.map(chips, (_, index) => chipTriggerId(index)),
			className: "max-w-xs",
			toContent: (triggerId) => [chipDescription(chips, triggerId)],
			toView: ({ trigger, portal }) =>
				h.div(
					[],
					[footerRow(h, rawSql, chipRow(h, chips, trigger)), ...(portal === null ? [] : [portal])],
				),
		},
	})
}

const footerRow = (h: H, rawSql: RawSqlState, chips: Html): Html => {
	const bucket = rawSql.draft.granularitySeconds
	return hstack(h, { gap: "3", align: "start", className: stripClass("dashed") }, [
		chips,
		field(h, { className: "flex-row items-center gap-2 pt-1.5 shrink-0", state: IDLE }, [
			fieldLabel(
				h,
				{
					ids: BUCKET_IDS,
					className: "font-normal text-2xs text-muted-foreground whitespace-nowrap sm:text-2xs",
					state: IDLE,
				},
				"Bucket",
			),
			input(h, {
				id: BUCKET_IDS.control,
				type: "number",
				size: "sm",
				className: "w-20 text-xs",
				attributes: [
					h.Min("1"),
					h.Placeholder("auto"),
					h.Value(bucket === null ? "" : String(bucket)),
					h.OnInput((value) => Message.ChangedSqlBucket({ value })),
				],
			}),
			typography(h, { size: "2xs", tone: "muted" }, ["s"]),
		]),
	])
}

/** The Raw SQL tab's body: the `$__orgFilter` message, the panel, and Run preview. */
export const rawSqlEditor = (h: H, model: Model, rawSql: RawSqlState): ReadonlyArray<Html> => {
	const error = rawSqlErrorOf(rawSql.draft)
	return [
		...(error === null ? [] : [fieldErrorText(h, { className: "font-medium" }, error)]),
		h.div(
			[h.Class("space-y-3")],
			[
				h.div(
					[h.Class("border rounded-md")],
					[
						header(h, rawSql),
						...(rawSql.isCollapsed
							? []
							: [
									h.div(
										[h.Class("p-3 space-y-3")],
										[editor(h, rawSql.draft.sql), footer(h, model, rawSql)],
									),
								]),
					],
				),
				hstack(h, { gap: "3" }, [
					button(
						h,
						{
							size: "sm",
							isDisabled: !isRunnableSql(rawSql),
							attributes: [h.OnClick(Message.ClickedRunPreview())],
						},
						["Run preview"],
					),
					typography(h, { size: "2xs", tone: "muted", className: "ml-auto" }, [
						"Targets ",
						inlineCode(h, {}, [
							model.state?.visualization ?? widgetOf(model)?.visualization ?? "",
						]),
					]),
				]),
			],
		),
	]
}
