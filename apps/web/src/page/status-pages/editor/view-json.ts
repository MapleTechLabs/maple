import type { StatusPageConfigChanges } from "@maple/domain/http/v2"
import { Option, Result } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { failureMessage } from "../../../data/load-failure"
import { alert, alertDescription, alertTitle } from "../../../ui/alert"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import { icon } from "../../../ui/icon"
import { label } from "../../../ui/label"
import { panel, panelBody, panelHeader } from "../../../ui/panel"
import { textarea } from "../../../ui/textarea"
import { adminOnlyNote } from "../../settings/kit/section"
import { formatConfig, problemText } from "./config-json"
import { Message } from "./message"
import type { Model } from "./model"
import { canApply, currentConfigOf, draftOf } from "./update-json"
import { isSettingsDirty } from "./update-settings"

// The JSON tab: the page as one document to copy, and for admins an editor that applies it.

type H = HtmlBuilder<Message>

const code = (h: H, text: string): Html => h.code([h.Class("font-mono text-xs")], [text])

const intro = (h: H): Html =>
	h.p(
		[h.Class("font-prose text-sm text-muted-foreground")],
		[
			"The page's settings, theme and components as one document, without incidents. Same document as ",
			code(h, "GET /v2/status_pages/{id}/config"),
			" and the MCP tool ",
			code(h, "get_status_page_config"),
			". Applying it replaces the page: a component without an ",
			code(h, "id"),
			" is added, one left out is deleted, and list order is display order.",
		],
	)

const changeRows = (changes: StatusPageConfigChanges): ReadonlyArray<readonly [string, string]> => [
	...(changes.fields.length === 0 ? [] : [["Fields changed", changes.fields.join(", ")] as const]),
	...(changes.created.length === 0 ? [] : [["Components to create", changes.created.join(", ")] as const]),
	...(changes.updated.length === 0 ? [] : [["Components to update", changes.updated.join(", ")] as const]),
	...(changes.deleted.length === 0 ? [] : [["Components to delete", changes.deleted.join(", ")] as const]),
	...(changes.reordered ? [["Order", "Components change order"] as const] : []),
]

const summary = (h: H, changes: StatusPageConfigChanges): Html => {
	const rows = changeRows(changes)
	return panel(h, {}, [
		panelHeader(h, { title: "Changes" }),
		panelBody(
			h,
			[
				rows.length === 0
					? h.p([h.Class("text-sm text-muted-foreground")], ["No changes yet."])
					: h.dl(
							[h.Class("grid grid-cols-[max-content_minmax(0,1fr)] gap-x-6 gap-y-1.5 text-sm")],
							rows.flatMap(([term, detail]) => [
								h.dt([h.Class("text-muted-foreground")], [term]),
								h.dd([h.Class("text-foreground")], [detail]),
							]),
						),
			],
			"p-4",
		),
	])
}

const readView = (h: H, model: Model, text: string): Html =>
	panel(h, {}, [
		panelHeader(h, {
			title: "status-page.json",
			action: h.div(
				[h.Class("flex items-center gap-2")],
				[
					CopyButton.view(h, {
						model: model.jsonCopy,
						toParentMessage: (message) => Message.GotJsonCopyMessage({ message }),
						value: text,
						label: "config JSON",
						idleLabel: "Copy",
						variant: "outline",
						size: "sm",
					}),
					...(model.isAdmin
						? [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										attributes: [h.OnClick(Message.ClickedEditJson())],
									},
									[icon(h, "PencilIcon"), "Edit JSON"],
								),
							]
						: []),
				],
			),
		}),
		h.pre(
			[
				h.AriaLabel("Status page config"),
				h.Class("max-h-[70vh] overflow-auto p-4 font-mono text-xs leading-relaxed text-foreground"),
			],
			[text],
		),
	])

const editView = (h: H, model: Model, draft: string): Html => {
	const parsed = draftOf(model)
	const problem = Option.flatMap(parsed, (result) => Result.getFailure(result))
	const changes = Option.flatMap(parsed, (result) =>
		Option.map(Result.getSuccess(result), (value) => value.changes),
	)
	const isBlocked = isSettingsDirty(model)
	return h.div(
		[h.Class("flex flex-col gap-4")],
		[
			...(isBlocked
				? [
						alert(h, { variant: "warn", size: "sm" }, [
							icon(h, "CircleWarningIcon"),
							alertTitle(h, ["Unsaved settings"]),
							alertDescription(h, [
								"The Settings tab has unsaved edits. Save or discard them before applying JSON.",
							]),
						]),
					]
				: []),
			h.div(
				[h.Class("flex flex-col gap-1.5")],
				[
					label(
						h,
						{
							className: "text-xs text-muted-foreground",
							attributes: [h.For("status-page-json")],
						},
						["Config JSON"],
					),
					textarea(h, {
						id: "status-page-json",
						isDisabled: model.isApplyingJson,
						controlClassName: "min-h-[28rem] font-mono text-xs leading-relaxed",
						attributes: [
							h.Value(draft),
							h.Rows(28),
							h.Spellcheck(false),
							h.Attribute("autocapitalize", "off"),
							h.OnInput((value) => Message.ChangedJson({ value })),
							...(Option.isSome(problem)
								? [h.AriaInvalid(true), h.AriaDescribedBy("status-page-json-error")]
								: []),
						],
					}),
				],
			),
			Option.match(problem, {
				onSome: (value) =>
					h.div(
						[h.Id("status-page-json-error")],
						[
							alert(h, { variant: "crit", size: "sm" }, [
								icon(h, "CircleXmarkIcon"),
								alertTitle(h, [
									value._tag === "Syntax" ? "Invalid JSON" : "Not a valid page config",
								]),
								alertDescription(h, [
									h.span([h.Class("font-mono text-xs")], [problemText(value)]),
								]),
							]),
						],
					),
				onNone: () =>
					Option.match(changes, { onSome: (value) => summary(h, value), onNone: () => h.empty }),
			}),
			...(model.jsonFailure === null
				? []
				: [
						alert(h, { variant: "crit", size: "sm" }, [
							icon(h, "CircleXmarkIcon"),
							alertTitle(h, ["Couldn't apply the config"]),
							alertDescription(h, [failureMessage(model.jsonFailure)]),
						]),
					]),
			h.div(
				[h.Class("flex items-center justify-end gap-2")],
				[
					button(
						h,
						{
							size: "sm",
							variant: "ghost",
							isDisabled: model.isApplyingJson,
							attributes: [h.OnClick(Message.ClickedResetJson())],
						},
						["Reset"],
					),
					button(
						h,
						{
							size: "sm",
							variant: "outline",
							isDisabled: model.isApplyingJson,
							attributes: [h.OnClick(Message.ClickedCancelJson())],
						},
						["Cancel"],
					),
					button(
						h,
						{
							size: "sm",
							isLoading: model.isApplyingJson,
							isDisabled: !canApply(model),
							attributes: [h.OnClick(Message.ClickedApplyJson())],
						},
						["Apply"],
					),
				],
			),
		],
	)
}

export const jsonTab = (h: H, model: Model): Html =>
	Option.match(currentConfigOf(model), {
		onNone: () => h.empty,
		onSome: (current) =>
			h.div(
				[h.Class("flex max-w-4xl flex-col gap-4")],
				[
					intro(h),
					...(model.isAdmin
						? []
						: [adminOnlyNote(h, ["Only org admins can apply a config. You can copy it."])]),
					model.isAdmin && model.jsonDraft !== null
						? editView(h, model, model.jsonDraft)
						: readView(h, model, formatConfig(current)),
				],
			),
	})
