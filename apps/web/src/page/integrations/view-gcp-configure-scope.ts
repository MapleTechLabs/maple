import type { V2GcpConnector } from "@maple/domain/http/v2"
import {
	GCP_SCOPE_NAMES,
	gcpOverlapNote,
	isGcpProjectId,
	isGcpResourceNumber,
} from "../../components/integrations/gcp-connector-state"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../ui/alert"
import * as Field from "../../ui/field"
import { icon } from "../../ui/icon"
import * as ToggleGroup from "../../ui/toggle-group"
import { PROJECT_ID_RULE, SCOPE_TYPES, SCOPES } from "./gcp-configure-copy"
import type { ConfigureModel } from "./gcp-configure-schema"
import type { Model } from "./model"
import { Message } from "./message"
import { GCP_TITLE, gcpCommand, SMALL } from "./view-gcp-parts"

// `ScopeFields`: what kind of thing to connect, and its ID.

type H = HtmlBuilder<Message>
type FieldName = "scopeId" | "hostProjectId"

const idsOf = (control: string): Field.FieldIds => ({
	control,
	label: `${control}-label`,
	description: `${control}-description`,
	error: `${control}-error`,
})

/** A rule turns red once its field was left, not while the first characters are being typed. */
export const scopeFields = (
	h: H,
	model: Model,
	configure: ConfigureModel,
	existing: ReadonlyArray<V2GcpConnector>,
): ReadonlyArray<Html> => {
	const scope = SCOPES[configure.scopeType]
	const aggregated = configure.scopeType !== "project"
	const scopeId = configure.scopeId.value.trim()
	const hostProjectId = configure.hostProjectId.value.trim()
	const scopeIdInvalid =
		configure.scopeId.isTouched &&
		scopeId.length > 0 &&
		!(aggregated ? isGcpResourceNumber(scopeId) : isGcpProjectId(scopeId))
	const hostInvalid =
		configure.hostProjectId.isTouched &&
		aggregated &&
		hostProjectId.length > 0 &&
		!isGcpProjectId(hostProjectId)
	const overlap = gcpOverlapNote(configure.scopeType, existing)
	return [
		h.div(
			[h.Class("flex flex-col gap-2")],
			[
				h.h3([h.Class(GCP_TITLE)], ["What should Maple watch?"]),
				ToggleGroup.view(h, {
					model: configure.scopeGroup,
					toParentMessage: (message) => Message.GotGcpScopeTypeMessage({ message }),
					items: SCOPE_TYPES.map((scopeType) => ({
						value: scopeType,
						label: GCP_SCOPE_NAMES[scopeType],
					})),
					variant: "outline",
					// Shrinks on a phone, where "Organization" otherwise runs past the card.
					itemClassName: "min-w-0 flex-1 px-1 sm:px-3",
					className: "w-full",
				}),
				h.p([h.Class(SMALL)], [scope.description]),
			],
		),
		idField(h, configure, {
			field: "scopeId",
			control: "gcp-scope-id",
			label: scope.idLabel,
			description: [
				scope.hint,
				" To list them, run ",
				gcpCommand(h, model, `configure-${configure.scopeType}`, scope.listCommand),
			],
			placeholder: scope.placeholder,
			isInvalid: scopeIdInvalid,
			rule: scope.idRule,
		}),
		...(aggregated
			? [
					idField(h, configure, {
						field: "hostProjectId",
						control: "gcp-host-project-id",
						label: "Host project ID",
						description: [
							"Holds Maple's Pub/Sub topic and read-only service account. A project inside the ",
							GCP_SCOPE_NAMES[configure.scopeType].toLowerCase(),
							" with billing enabled that won't be deleted.",
						],
						placeholder: "acme-observability",
						isInvalid: hostInvalid,
						rule: PROJECT_ID_RULE,
					}),
				]
			: []),
		...(overlap === null
			? []
			: [
					alert(h, { size: "sm", role: "note" }, [
						icon(h, "CircleInfoIcon", { size: 14 }),
						alertDescription(h, [overlap], "leading-5 text-pretty"),
					]),
				]),
	]
}

const idField = (
	h: H,
	configure: ConfigureModel,
	options: Readonly<{
		field: FieldName
		control: string
		label: string
		description: ReadonlyArray<Html | string>
		placeholder: string
		isInvalid: boolean
		rule: string
	}>,
): Html => {
	const model = configure[options.field]
	const state = Field.stateOf(model, options.isInvalid)
	const ids = idsOf(options.control)
	return Field.field(h, { className: "items-stretch gap-2", state }, [
		Field.fieldLabel(h, { ids, state }, options.label),
		Field.fieldDescription(h, { ids, state, className: "leading-5 text-pretty" }, options.description),
		Field.input(h, {
			ids,
			state,
			className: "font-mono",
			attributes: [
				h.Autocomplete("off"),
				h.Spellcheck(false),
				h.Placeholder(options.placeholder),
				...Field.controlAttributes(h, model, (message) =>
					Message.GotGcpScopeFieldMessage({ field: options.field, message }),
				),
			],
		}),
		...(options.isInvalid
			? [Field.fieldError(h, { ids, state, className: "leading-5 text-pretty" }, options.rule)]
			: []),
	])
}
