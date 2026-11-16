import type { SecurityAuditFindingTriageStatus } from "@maple/domain/http"
import type { SecurityAuditFindingStatus } from "@maple/domain/security-audit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import * as Field from "@maple/views/ui/field"
import { textarea } from "@maple/views/ui/textarea"
import * as ToggleGroup from "@maple/views/ui/toggle-group"
import { typography } from "@maple/views/ui/typography"
import { vstackClass } from "@maple/views/ui/stack"
import { Array as Arr, Option, String as Str } from "effect"

// A finding's triage form: open, dismiss or accept the risk, with a required reason. The finding
// page and a pull request run's finding sheet both show it; each owner keeps the state.

export const TRIAGE_STATUSES: ReadonlyArray<SecurityAuditFindingTriageStatus> = [
	"open",
	"dismissed",
	"accepted_risk",
]

const TRIAGE_OPTIONS: ReadonlyArray<{ value: SecurityAuditFindingTriageStatus; label: string }> = [
	{ value: "open", label: "Open" },
	{ value: "dismissed", label: "Dismiss" },
	{ value: "accepted_risk", label: "Accept risk" },
]

const REASON_MAX = 2000

export const reasonErrorOf = (reason: string): string | null =>
	Str.trim(reason) === ""
		? "A reason is required. It is recorded in the org audit log with your name."
		: Str.trim(reason).length > REASON_MAX
			? `Keep the reason under ${REASON_MAX} characters.`
			: null

/** `fixed` is the engine's; a person triages a fixed finding as if it were open. */
export const currentTriageOf = (status: SecurityAuditFindingStatus): SecurityAuditFindingTriageStatus =>
	status === "fixed" ? "open" : status

/** The status the control shows: the picked one, else the finding's own. */
export const pickedTriageOf = (
	triage: ToggleGroup.Model,
	status: SecurityAuditFindingStatus,
): SecurityAuditFindingTriageStatus =>
	Option.getOrElse(
		Arr.findFirst(TRIAGE_STATUSES, (value) => value === triage.values[0]),
		() => currentTriageOf(status),
	)

export type TriageFormOptions<M> = Readonly<{
	/** Prefixes the reason field's ids, so two forms on a page never share one. */
	idPrefix: string
	status: SecurityAuditFindingStatus
	triage: ToggleGroup.Model
	reason: Field.Model
	isSubmitted: boolean
	isSaving: boolean
	/** The line under the control: what a status change does here. */
	hint: string
	onTriage: (message: ToggleGroup.Message) => M
	onReason: (message: Field.Message) => M
	onSubmit: M
}>

/** The triage control, its hint, the reason and the Update status button, as one form. */
export const triageForm = <M>(h: HtmlBuilder<M>, options: TriageFormOptions<M>): Html => {
	const picked = pickedTriageOf(options.triage, options.status)
	const isChange = picked !== currentTriageOf(options.status) || options.status === "fixed"
	const reasonError = options.isSubmitted ? reasonErrorOf(options.reason.value) : null
	const ids: Field.FieldIds = {
		control: `${options.idPrefix}-reason`,
		label: `${options.idPrefix}-reason-label`,
		error: `${options.idPrefix}-reason-error`,
		description: `${options.idPrefix}-reason-description`,
	}
	const state = Field.stateOf(options.reason, reasonError !== null)
	return h.form(
		[h.Class(vstackClass({ gap: "3" })), h.OnSubmit(options.onSubmit)],
		[
			ToggleGroup.view(h, {
				model: options.triage,
				toParentMessage: options.onTriage,
				items: TRIAGE_OPTIONS,
				variant: "outline",
				size: "xs",
				className: "w-full",
				itemClassName: "min-w-0 flex-1 px-1",
			}),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [options.hint]),
			Field.field(h, { state }, [
				Field.fieldLabel(h, { ids, state }, "Reason"),
				textarea(h, {
					id: ids.control,
					attributes: [
						h.Placeholder(
							picked !== "open"
								? "Why is this being dismissed or accepted?"
								: options.status === "open"
									? "Pick Dismiss or Accept risk, then say why"
									: "Why is this being reopened?",
						),
						h.AriaLabelledBy(ids.label),
						h.AriaDescribedBy(reasonError === null ? (ids.description ?? "") : ids.error),
						h.AriaInvalid(reasonError !== null),
						h.Rows(3),
						h.Value(options.reason.value),
						h.OnInput((value) => options.onReason(Field.Message.ChangedValue({ value }))),
						h.OnBlur(options.onReason(Field.Message.BlurredControl())),
					],
				}),
				reasonError === null
					? Field.fieldDescription(
							h,
							{ ids, state },
							"Required. Recorded in the org audit log with your name.",
						)
					: Field.fieldError(h, { ids, state, attributes: [h.Role("alert")] }, reasonError),
			]),
			button(
				h,
				{
					type: "submit",
					variant: "outline",
					isLoading: options.isSaving,
					isDisabled: !isChange || options.isSaving,
					className: "w-full",
				},
				["Update status"],
			),
		],
	)
}
