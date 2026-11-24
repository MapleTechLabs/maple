import type { RoleMemberResponse } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "@maple/views/ui/display"
import { field, fieldDescription, type FieldState, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { meter } from "@maple/views/ui/meter"
import { personLabel } from "@maple/views/ui/person-avatar"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { PERMISSION_TOTAL, permissionCountLabel } from "./roles"

// Pieces the Roles tab, the role editor and the create dialog draw the same way.

/** "Built-in" with a lock, or "Custom": the same quiet chip, since neither is a status. */
export const roleTypeBadge = <M>(h: HtmlBuilder<M>, isBuiltIn: boolean): Html =>
	isBuiltIn
		? badge(h, { variant: "meta", size: "sm" }, [icon(h, "LockIcon"), "Built-in"])
		: badge(h, { variant: "meta", size: "sm" }, ["Custom"])

/** "All 49" or "16 of 49" over a thin meter, the same tone for every role. */
export const permissionMeter = <M>(h: HtmlBuilder<M>, count: number): Html =>
	hstack(h, { gap: "2.5" }, [
		typography(h, { size: "xs", tone: "foreground", numeric: true, className: "w-14 shrink-0" }, [
			permissionCountLabel(count),
		]),
		meter(h, {
			value: count,
			max: PERMISSION_TOTAL,
			tone: "neutral",
			className: "w-16",
		}),
	])

/** Someone who holds a role: avatar, name (their email or username when they set none) and identifier. */
export const holderLabel = <M>(h: HtmlBuilder<M>, member: RoleMemberResponse): Html =>
	personLabel(h, {
		name: member.name ?? member.identifier,
		imageUrl: member.imageUrl ?? undefined,
		detail: member.identifier,
	})

/** A labelled text input whose value lives in the owner's Model. */
export const roleTextField = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		id: string
		label: string
		value: string
		onInput: (value: string) => M
		description?: string
		placeholder?: string
		isDisabled?: boolean
		isInvalid?: boolean
		maxLength?: number
	}>,
): Html => {
	const state: FieldState = {
		isInvalid: options.isInvalid ?? false,
		isDirty: false,
		isFilled: options.value !== "",
		isFocused: false,
		isTouched: false,
	}
	const base = { control: options.id, label: `${options.id}-label`, error: `${options.id}-error` }
	const ids =
		options.description === undefined ? base : { ...base, description: `${options.id}-description` }
	return field(h, { state }, [
		fieldLabel(h, { ids, state }, options.label),
		input(h, {
			ids,
			state,
			isDisabled: options.isDisabled,
			attributes: [
				h.Value(options.value),
				h.OnInput(options.onInput),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...(options.maxLength === undefined ? [] : [h.Maxlength(options.maxLength)]),
			],
		}),
		...(options.description === undefined
			? []
			: [fieldDescription(h, { ids, state }, options.description)]),
	])
}
