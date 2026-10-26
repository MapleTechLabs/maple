import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { input } from "../../../ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import { label } from "../../../ui/label"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { segmentedSelect } from "../../../ui/segmented-select"
import { textarea } from "../../../ui/textarea"
import { sectionHeading } from "../../kit/section-heading"
import {
	ASSERTION_OPS,
	ASSERTION_TYPES,
	type AssertionDraft,
	AssertionType,
	HttpMethod,
	INTERVALS,
	type TextField,
} from "./form"
import { Message } from "./message"
import type { Model } from "./model"

// The form's inputs and the HTTP and schedule sections.

export type H = HtmlBuilder<Message>

const changed = (field: TextField) => (value: string) => Message.ChangedText({ field, value })

/** A labelled text input bound to one form field. */
export const textField = (
	h: H,
	options: Readonly<{
		field: TextField
		label: string
		value: string
		placeholder?: string
		suffix?: string
		hint?: string
		inputMode?: "numeric" | "text"
		className?: string
	}>,
): Html => {
	const id = `uptime-${options.field}`
	const attributes = [
		h.Value(options.value),
		h.OnInput(changed(options.field)),
		...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
		...(options.inputMode === "numeric" ? [h.Attribute("inputmode", "numeric")] : []),
	]
	return h.div(
		[h.Class(cn("flex flex-col gap-1.5", options.className))],
		[
			label(h, { attributes: [h.For(id)] }, [options.label]),
			options.suffix === undefined
				? input(h, { id, attributes })
				: inputGroup(h, {}, [
						inputGroupInput(h, { id, attributes }),
						inputGroupAddon(h, { align: "inline-end" }, [
							inputGroupText(h, {}, [options.suffix]),
						]),
					]),
			...(options.hint === undefined
				? []
				: [h.p([h.Class("text-xs text-muted-foreground")], [options.hint])]),
		],
	)
}

/** A labelled native select. */
export const selectField = (
	h: H,
	options: Readonly<{
		id: string
		label: string
		value: string
		entries: ReadonlyArray<{ value: string; label: string }>
		onChange: (value: string) => Message
		className?: string
		isLabelHidden?: boolean
	}>,
): Html =>
	h.div(
		[h.Class(cn("flex flex-col gap-1.5", options.className))],
		[
			label(
				h,
				{
					className: options.isLabelHidden === true ? "sr-only" : undefined,
					attributes: [h.For(options.id)],
				},
				[options.label],
			),
			nativeSelect(
				h,
				{ defaultValue: options.value, attributes: [h.Id(options.id), h.OnChange(options.onChange)] },
				options.entries.map((entry) => nativeOption(entry.value, entry.label)),
			),
		],
	)

const section = (h: H, title: string, hint: string | undefined, children: ReadonlyArray<Html>): Html =>
	h.section(
		[h.Class("flex flex-col gap-4 border-t pt-6")],
		[sectionHeading(h, { title, ...(hint === undefined ? undefined : { hint }) }), ...children],
	)

const isMethod = (value: string): value is typeof HttpMethod.Type =>
	HttpMethod.literals.some((method) => method === value)
const isAssertionType = (value: string): value is AssertionType =>
	AssertionType.literals.some((type) => type === value)

/** Method and URL, the name, and the collapsible headers and body editor. */
export const requestSection = (h: H, model: Model, isAdvancedOpen: boolean): Html => {
	const form = model.form
	return section(h, "Request", undefined, [
		h.div(
			[h.Class("flex items-end gap-2")],
			[
				selectField(h, {
					id: "uptime-method",
					label: "Method",
					value: form.method,
					entries: HttpMethod.literals.map((method) => ({ value: method, label: method })),
					onChange: (value) => Message.ChangedMethod({ method: isMethod(value) ? value : "GET" }),
					className: "w-28",
				}),
				textField(h, {
					field: "url",
					label: "URL",
					value: form.url,
					placeholder: "https://api.example.com/health",
					className: "min-w-0 flex-1",
				}),
			],
		),
		textField(h, { field: "name", label: "Name", value: form.name, placeholder: "Defaults to the URL" }),
		h.details(
			[h.Class("rounded-md border px-3 py-2"), ...(isAdvancedOpen ? [h.Attribute("open", "")] : [])],
			[
				h.summary(
					[h.Class("cursor-pointer text-sm text-muted-foreground")],
					["Headers, body and auth"],
				),
				h.div(
					[h.Class("mt-3 flex flex-col gap-3")],
					[
						h.div(
							[h.Class("flex flex-col gap-1.5")],
							[
								label(h, { attributes: [h.For("uptime-headers")] }, [
									"Headers, one per line",
								]),
								textarea(h, {
									id: "uptime-headers",
									attributes: [
										h.Value(form.headers),
										h.OnInput(changed("headers")),
										h.Placeholder("Authorization: Bearer …"),
									],
								}),
							],
						),
						...(form.method === "POST"
							? [
									h.div(
										[h.Class("flex flex-col gap-1.5")],
										[
											label(h, { attributes: [h.For("uptime-body")] }, ["Body"]),
											textarea(h, {
												id: "uptime-body",
												attributes: [h.Value(form.body), h.OnInput(changed("body"))],
											}),
										],
									),
								]
							: []),
					],
				),
			],
		),
	])
}

const assertionRow = (h: H, row: AssertionDraft, index: number): Html => {
	const ops = ASSERTION_OPS[row.type]
	const needsTarget = row.type === "json_path" || row.type === "header"
	const needsValue = row.op !== "exists"
	const valueLabel = `Check ${index + 1} value`
	return h.li(
		[h.Key(String(row.id)), h.Class("flex flex-wrap items-end gap-2 px-3 py-2")],
		[
			selectField(h, {
				id: `uptime-assertion-${row.id}-type`,
				label: `Check ${index + 1} type`,
				isLabelHidden: true,
				value: row.type,
				entries: ASSERTION_TYPES,
				onChange: (value) =>
					Message.ChangedAssertionType({
						id: row.id,
						type: isAssertionType(value) ? value : "status",
					}),
				className: "w-36",
			}),
			...(needsTarget
				? [
						h.div(
							[h.Class("w-36")],
							[
								input(h, {
									id: `uptime-assertion-${row.id}-target`,
									attributes: [
										h.AriaLabel(
											row.type === "header"
												? `Check ${index + 1} header name`
												: `Check ${index + 1} path`,
										),
										h.Placeholder(row.type === "header" ? "content-type" : "$.status"),
										h.Value(row.target),
										h.OnInput((value) =>
											Message.ChangedAssertion({ id: row.id, part: "target", value }),
										),
									],
								}),
							],
						),
					]
				: []),
			selectField(h, {
				id: `uptime-assertion-${row.id}-op`,
				label: `Check ${index + 1} operator`,
				isLabelHidden: true,
				value: row.op,
				entries: ops,
				onChange: (value) => Message.ChangedAssertion({ id: row.id, part: "op", value }),
				className: "w-36",
			}),
			...(needsValue
				? [
						h.div(
							[h.Class("min-w-32 flex-1")],
							[
								input(h, {
									id: `uptime-assertion-${row.id}-value`,
									attributes: [
										h.AriaLabel(valueLabel),
										h.Value(row.value),
										h.OnInput((value) =>
											Message.ChangedAssertion({ id: row.id, part: "value", value }),
										),
										...(row.type === "latency" ? [h.Placeholder("Milliseconds")] : []),
									],
								}),
							],
						),
					]
				: [h.span([h.Class("flex-1")], [])]),
			iconButton(
				h,
				{
					label: `Remove check ${index + 1}`,
					className: "text-muted-foreground",
					attributes: [h.OnClick(Message.RemovedAssertion({ id: row.id }))],
				},
				[icon(h, "XmarkIcon")],
			),
		],
	)
}

/** "Up when": every row must pass. */
export const assertionsSection = (h: H, model: Model): Html =>
	section(h, "Up when", "every check below passes", [
		h.div(
			[h.Class("rounded-md border")],
			[
				h.ul(
					[h.Class("divide-y")],
					model.form.assertions.map((row, index) => assertionRow(h, row, index)),
				),
				h.div(
					[h.Class(cn("px-3 py-2", model.form.assertions.length > 0 && "border-t"))],
					[
						button(
							h,
							{
								variant: "ghost",
								size: "sm",
								attributes: [h.OnClick(Message.AddedAssertion())],
							},
							[icon(h, "PlusIcon"), "Add check: keyword, JSON path or header"],
						),
					],
				),
			],
		),
	])

/** Cadence, failures in a row and the timeout. */
export const scheduleSection = (h: H, model: Model): Html =>
	section(h, "Schedule", undefined, [
		h.div(
			[h.Class("grid gap-4 sm:grid-cols-3")],
			[
				h.div(
					[h.Class("flex flex-col gap-1.5")],
					[
						h.span([h.Class("text-sm font-medium")], ["Check every"]),
						segmentedSelect(h, {
							ariaLabel: "Check every",
							value: String(model.form.intervalSeconds),
							onChange: (value) => Message.PickedInterval({ seconds: Number(value) }),
							options: INTERVALS.map((interval) => ({
								value: String(interval.seconds),
								label: interval.label,
							})),
						}),
					],
				),
				textField(h, {
					field: "failuresToDown",
					label: "Down after",
					value: model.form.failuresToDown,
					suffix: "failures in a row",
					inputMode: "numeric",
				}),
				textField(h, {
					field: "timeoutMs",
					label: "Timeout",
					value: model.form.timeoutMs,
					suffix: "ms",
					inputMode: "numeric",
				}),
			],
		),
	])

export { section }
