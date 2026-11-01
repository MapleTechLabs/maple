import { IngestRuleDetector, IngestRuleRedactMethod, IngestRuleScope } from "@maple/domain/ingest-rules"
import type { Html } from "foldkit/html"
import * as Checkbox from "../../../ui/checkbox"
import { input } from "../../../ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "../../../ui/input-group"
import { label } from "../../../ui/label"
import { segmentedSelect } from "../../../ui/segmented-select"
import { textarea } from "../../../ui/textarea"
import type { ActionType } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { DETECTOR_LABELS } from "./summary"
import { clause, type H } from "./view-form"

// The "then ..." half of the sentence: drop with a keep share, or redact.

const SCOPE_LABELS = {
	attributes: "Attributes",
	resource: "Resource attributes",
	events: "Span events",
	body: "Log body",
} satisfies Record<IngestRuleScope, string>

const METHOD_LABELS = {
	mask: "Mask",
	hash: "Hash",
	remove: "Remove",
} satisfies Record<IngestRuleRedactMethod, string>

const fieldLabel = (h: H, id: string, text: string): Html => label(h, { attributes: [h.For(id)] }, [text])

const checkboxRow = (h: H, id: string, isChecked: boolean, text: string, onToggle: Message): Html =>
	h.label(
		[h.Key(id), h.Id(Checkbox.labelId(id)), h.Class("flex items-center gap-2 text-sm")],
		[
			...Checkbox.view(h, {
				model: { isChecked },
				toParentMessage: () => onToggle,
				id: `${id}-root`,
				inputId: id,
			}),
			text,
		],
	)

const dropControls = (h: H, model: Model): ReadonlyArray<Html> => [
	h.div(
		[h.Class("flex max-w-56 flex-col gap-1.5")],
		[
			fieldLabel(h, "ingest-rule-keep", "Keep a sample"),
			inputGroup(h, {}, [
				inputGroupInput(h, {
					id: "ingest-rule-keep",
					attributes: [
						h.Value(model.draft.keepPercent),
						h.Attribute("inputmode", "numeric"),
						h.OnInput((value) => Message.ChangedText({ part: "keepPercent", value })),
					],
				}),
				inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, ["%"])]),
			]),
			h.p(
				[h.Class("text-muted-foreground text-xs")],
				["0 drops every match. Sampling follows the trace id, so traces stay whole."],
			),
		],
	),
]

const redactControls = (h: H, model: Model): ReadonlyArray<Html> => {
	const draft = model.draft
	return [
		h.div(
			[h.Class("flex flex-col gap-1.5")],
			[
				fieldLabel(h, "ingest-rule-keys", "Keys"),
				input(h, {
					id: "ingest-rule-keys",
					attributes: [
						h.Value(draft.keys),
						h.Placeholder("*password*, http.request.header.authorization"),
						h.OnInput((value) => Message.ChangedText({ part: "keys", value })),
					],
				}),
				h.p(
					[h.Class("text-muted-foreground text-xs")],
					["Comma-separated. The whole value is replaced. * matches any characters."],
				),
			],
		),
		h.fieldset(
			[h.Class("flex flex-col gap-2")],
			[
				h.legend([h.Class("mb-1 text-sm font-medium")], ["Detect"]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-2")],
					IngestRuleDetector.literals.map((detector) =>
						checkboxRow(
							h,
							`ingest-rule-detector-${detector}`,
							draft.detectors.includes(detector),
							DETECTOR_LABELS[detector],
							Message.ToggledDetector({ detector }),
						),
					),
				),
			],
		),
		h.div(
			[h.Class("flex flex-col gap-1.5")],
			[
				fieldLabel(h, "ingest-rule-patterns", "Custom patterns"),
				textarea(h, {
					id: "ingest-rule-patterns",
					size: "sm",
					controlClassName: "font-mono",
					attributes: [
						h.Value(draft.patterns),
						h.Placeholder("ORD-[0-9]+"),
						h.OnInput((value) => Message.ChangedText({ part: "patterns", value })),
					],
				}),
				h.p(
					[h.Class("text-muted-foreground text-xs")],
					["One regex per line. Only the matched text is replaced."],
				),
			],
		),
		h.fieldset(
			[h.Class("flex flex-col gap-2")],
			[
				h.legend([h.Class("mb-1 text-sm font-medium")], ["Look in"]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-2")],
					IngestRuleScope.literals.map((scope) =>
						checkboxRow(
							h,
							`ingest-rule-scope-${scope}`,
							draft.scopes.includes(scope),
							SCOPE_LABELS[scope],
							Message.ToggledScope({ scope }),
						),
					),
				),
			],
		),
		h.div(
			[h.Class("flex flex-col gap-1.5")],
			[
				h.span([h.Class("text-sm font-medium")], ["Replace with"]),
				segmentedSelect<IngestRuleRedactMethod, Message>(h, {
					size: "sm",
					ariaLabel: "Redaction method",
					value: draft.method,
					onChange: (method) => Message.PickedMethod({ method }),
					options: IngestRuleRedactMethod.literals.map((method) => ({
						value: method,
						label: METHOD_LABELS[method],
					})),
				}),
				h.p(
					[h.Class("text-muted-foreground text-xs")],
					[
						draft.method === "mask"
							? "Key matches become [REDACTED]; detector matches become [REDACTED:email] and the like."
							: draft.method === "hash"
								? "Writes hash:<hex16>, a keyed hash that is the same for the same value."
								: "Deletes attributes matched by key. Detector and pattern matches are masked.",
					],
				),
			],
		),
	]
}

export const actionClause = (h: H, model: Model): Html =>
	clause(h, "Then", [
		segmentedSelect<ActionType, Message>(h, {
			size: "sm",
			ariaLabel: "Action",
			value: model.draft.actionType,
			onChange: (actionType) => Message.PickedAction({ actionType }),
			options: [
				{ value: "drop", label: "Drop" },
				{ value: "redact", label: "Redact" },
			],
			className: "self-start",
		}),
		...(model.draft.actionType === "drop" ? dropControls(h, model) : redactControls(h, model)),
	])
