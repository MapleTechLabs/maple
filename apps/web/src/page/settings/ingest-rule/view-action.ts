import {
	IngestParseSource,
	IngestRuleDetector,
	IngestRuleRedactMethod,
	IngestRuleScope,
	IngestTimestampFormat,
} from "@maple/domain/ingest-rules"
import { borderedBox } from "@maple/views/ui/bordered-box"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { iconButton } from "@maple/views/ui/icon-button"
import type { Html } from "foldkit/html"
import * as Checkbox from "@maple/views/ui/checkbox"
import { input } from "@maple/views/ui/input"
import { inputGroup, inputGroupAddon, inputGroupInput, inputGroupText } from "@maple/views/ui/input-group"
import { label } from "@maple/views/ui/label"
import { segmentedSelect } from "@maple/views/ui/segmented-select"
import { textarea } from "@maple/views/ui/textarea"
import { type ActionType, STEP_LABELS, StepKind, type StepDraft } from "./form"
import { Message } from "./message"
import type { Model } from "./model"
import { DETECTOR_LABELS } from "./summary"
import { clause, type H, select } from "./view-form"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The "then ..." half of the sentence: drop with a keep share, redact, or parse logs.

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
	label(
		h,
		{
			className: "flex items-center gap-2 text-sm font-normal",
			attributes: [h.Key(id), h.Id(Checkbox.labelId(id))],
		},
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
	vstack(h, { gap: "1.5", className: "max-w-56" }, [
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
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"0 drops every match. Sampling follows the trace id, so traces stay whole.",
		]),
	]),
]

const redactControls = (h: H, model: Model): ReadonlyArray<Html> => {
	const draft = model.draft
	return [
		vstack(h, { gap: "1.5" }, [
			fieldLabel(h, "ingest-rule-keys", "Keys"),
			input(h, {
				id: "ingest-rule-keys",
				attributes: [
					h.Value(draft.keys),
					h.Placeholder("*password*, http.request.header.authorization"),
					h.OnInput((value) => Message.ChangedText({ part: "keys", value })),
				],
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"Comma-separated. The whole value is replaced. * matches any characters.",
			]),
		]),
		h.fieldset(
			[h.Class(vstackClass({ gap: "2" }))],
			[
				h.legend([h.Class("mb-1 text-sm font-medium")], ["Detect"]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-2")],
					Arr.map(IngestRuleDetector.literals, (detector) =>
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
		vstack(h, { gap: "1.5" }, [
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
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				"One regex per line. Only the matched text is replaced.",
			]),
		]),
		h.fieldset(
			[h.Class(vstackClass({ gap: "2" }))],
			[
				h.legend([h.Class("mb-1 text-sm font-medium")], ["Look in"]),
				h.div(
					[h.Class("grid gap-2 sm:grid-cols-2")],
					Arr.map(IngestRuleScope.literals, (scope) =>
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
		vstack(h, { gap: "1.5" }, [
			typography(h, { size: "sm", weight: "medium" }, ["Replace with"]),
			segmentedSelect<IngestRuleRedactMethod, Message>(h, {
				size: "sm",
				ariaLabel: "Redaction method",
				value: draft.method,
				onChange: (method) => Message.PickedMethod({ method }),
				options: Arr.map(IngestRuleRedactMethod.literals, (method) => ({
					value: method,
					label: METHOD_LABELS[method],
				})),
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				draft.method === "mask"
					? "Key matches become [REDACTED]; detector matches become [REDACTED:email] and the like."
					: draft.method === "hash"
						? "Writes hash:<hex16>, a keyed hash that is the same for the same value."
						: "Deletes attributes matched by key. Detector and pattern matches are masked.",
			]),
		]),
	]
}

const SOURCE_LABELS = { body: "Body", attribute: "Attribute" } satisfies Record<IngestParseSource, string>

const FORMAT_LABELS = {
	rfc3339: "RFC 3339 / ISO 8601",
	unix_s: "Unix seconds",
	unix_ms: "Unix milliseconds",
	unix_us: "Unix microseconds",
	unix_ns: "Unix nanoseconds",
	common_log: "Common log (10/Oct/2000:13:55:36 -0700)",
} satisfies Record<IngestTimestampFormat, string>

const STEP_HINTS = {
	json: "Flattens a JSON object into attributes with dotted keys (http.status).",
	regex: "Named groups become attributes: (?<status>[0-9]+). Linear-time, so .* is safe.",
	grok: "%{PATTERN:field} or %{PATTERN:field:int}. Library: INT, NUMBER, WORD, NOTSPACE, DATA, GREEDYDATA, QS, IP, HOSTNAME, URIPATHPARAM, UUID, LOGLEVEL, TIMESTAMP_ISO8601, HTTPDATE, COMBINEDAPACHELOG.",
	severity: "A level name (warn, ERROR, notice) or a number from 1 to 24 sets the log severity.",
	timestamp: "Sets the log timestamp.",
} satisfies Record<StepKind, string>

const isStepKind = (value: string): value is StepKind => Arr.some(StepKind.literals, (kind) => kind === value)
const isFormat = (value: string): value is IngestTimestampFormat =>
	Arr.some(IngestTimestampFormat.literals, (format) => format === value)

const stepId = (step: StepDraft, part: string) => `ingest-rule-step-${step.id}-${part}`

const stepHeader = (h: H, step: StepDraft, index: number, count: number): Html =>
	hstack(h, { gap: "2", justify: "between" }, [
		hstack(h, { gap: "2" }, [
			typography(h, { size: "xs", tone: "muted", mono: true, numeric: true }, [String(index + 1)]),
			select(h, {
				id: stepId(step, "kind"),
				label: `Step ${index + 1} kind`,
				value: step.kind,
				entries: Arr.map(StepKind.literals, (kind) => ({ value: kind, label: STEP_LABELS[kind] })),
				onChange: (value) =>
					Message.ChangedStepKind({ id: step.id, kind: isStepKind(value) ? value : step.kind }),
			}),
		]),
		hstack(h, { gap: "1" }, [
			iconButton(
				h,
				{
					label: `Move step ${index + 1} up`,
					isDisabled: index === 0,
					attributes: [h.OnClick(Message.MovedStep({ id: step.id, by: -1 }))],
				},
				[icon(h, "ArrowUpIcon")],
			),
			iconButton(
				h,
				{
					label: `Move step ${index + 1} down`,
					isDisabled: index === count - 1,
					attributes: [h.OnClick(Message.MovedStep({ id: step.id, by: 1 }))],
				},
				[icon(h, "ArrowDownIcon")],
			),
			iconButton(
				h,
				{
					label: `Remove step ${index + 1}`,
					attributes: [h.OnClick(Message.RemovedStep({ id: step.id }))],
				},
				[icon(h, "XmarkIcon")],
			),
		]),
	])

const sourceControls = (h: H, step: StepDraft): Html =>
	hstack(h, { gap: "2", wrap: true }, [
		segmentedSelect<IngestParseSource, Message>(h, {
			size: "xs",
			ariaLabel: "Read from",
			value: step.source,
			onChange: (source) => Message.ChangedStepSource({ id: step.id, source }),
			options: Arr.map(IngestParseSource.literals, (source) => ({
				value: source,
				label: SOURCE_LABELS[source],
			})),
		}),
		...(step.source === "attribute"
			? [
					input(h, {
						id: stepId(step, "key"),
						size: "sm",
						className: "w-48 font-mono",
						attributes: [
							h.AriaLabel("Attribute key"),
							h.Value(step.key),
							h.Placeholder("message"),
							h.OnInput((value) =>
								Message.ChangedStepText({ id: step.id, part: "key", value }),
							),
						],
					}),
				]
			: []),
	])

const stepFields = (h: H, step: StepDraft): ReadonlyArray<Html> => [
	sourceControls(h, step),
	...(step.kind === "regex" || step.kind === "grok"
		? [
				textarea(h, {
					id: stepId(step, "pattern"),
					size: "sm",
					controlClassName: "font-mono",
					attributes: [
						h.AriaLabel(step.kind === "grok" ? "Grok pattern" : "Regex"),
						h.Value(step.pattern),
						h.Placeholder(
							step.kind === "grok"
								? "%{IP:client.address} %{WORD:method} %{NOTSPACE:path}"
								: "^(?<method>[A-Z]+) (?<path>[^ ]+) (?<status>[0-9]{3})",
						),
						h.OnInput((value) =>
							Message.ChangedStepText({ id: step.id, part: "pattern", value }),
						),
					],
				}),
			]
		: []),
	...(step.kind === "timestamp"
		? [
				select(h, {
					id: stepId(step, "format"),
					label: "Timestamp format",
					value: step.format,
					entries: Arr.map(IngestTimestampFormat.literals, (format) => ({
						value: format,
						label: FORMAT_LABELS[format],
					})),
					onChange: (value) =>
						Message.ChangedStepFormat({
							id: step.id,
							format: isFormat(value) ? value : step.format,
						}),
					className: "self-start",
				}),
			]
		: []),
	...(step.kind === "json" || step.kind === "regex" || step.kind === "grok"
		? [
				input(h, {
					id: stepId(step, "prefix"),
					size: "sm",
					className: "w-48 font-mono",
					attributes: [
						h.AriaLabel("Key prefix"),
						h.Value(step.prefix),
						h.Placeholder("Key prefix (optional)"),
						h.OnInput((value) => Message.ChangedStepText({ id: step.id, part: "prefix", value })),
					],
				}),
			]
		: []),
	typography(h, { size: "xs", tone: "muted", as: "p" }, [STEP_HINTS[step.kind]]),
]

const parseControls = (h: H, model: Model): ReadonlyArray<Html> => {
	const steps = model.draft.steps
	return [
		h.ol(
			[h.AriaLabel("Steps"), h.Class(vstackClass({ gap: "2" }))],
			Arr.map(steps, (step, index) =>
				h.li(
					[h.Key(String(step.id))],
					[
						borderedBox(h, { overflow: "hidden", card: true, className: "p-3" }, [
							vstack(h, { gap: "2" }, [
								stepHeader(h, step, index, steps.length),
								...stepFields(h, step),
							]),
						]),
					],
				),
			),
		),
		hstack(
			h,
			{ gap: "1.5", wrap: true },
			Arr.map(StepKind.literals, (kind) =>
				button(
					h,
					{ variant: "outline", size: "sm", attributes: [h.OnClick(Message.AddedStep({ kind }))] },
					[
						icon(h, "PlusIcon", { attributes: [h.DataAttribute("icon", "inline-start")] }),
						STEP_LABELS[kind],
					],
				),
			),
		),
		typography(h, { size: "xs", tone: "muted", as: "p" }, [
			"Steps run in order after drop rules and before redact rules. A failed step keeps the log and sets maple.parse.error.",
		]),
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
				{ value: "parse", label: "Parse", isDisabled: !model.draft.signals.includes("logs") },
			],
			className: "self-start",
		}),
		...(model.draft.actionType === "drop"
			? dropControls(h, model)
			: model.draft.actionType === "parse"
				? parseControls(h, model)
				: redactControls(h, model)),
	])
