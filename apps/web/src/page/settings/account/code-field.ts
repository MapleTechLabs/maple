import type { Html, HtmlBuilder } from "foldkit/html"
import { label } from "../../../ui/label"
import * as OtpField from "../../../ui/otp-field"

// `CodeField`: six digits for an email or TOTP code. Slot one carries the field's name through a real label;
// the others name their position.

const SLOTS = [0, 1, 2, 3, 4, 5]

export const initCode = (id: string): OtpField.Model => OtpField.init({ id, length: SLOTS.length })

export const isComplete = (model: OtpField.Model): boolean => OtpField.valueOf(model).length === SLOTS.length

export const codeField = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ model: OtpField.Model; label: string; toParentMessage: (message: OtpField.Message) => M }>,
): Html => {
	const config = { model: options.model, toParentMessage: options.toParentMessage, size: "lg" as const }
	return h.div(
		[h.Class("space-y-1.5")],
		[
			label(h, { attributes: [h.For(OtpField.slotId(options.model.id, 0))] }, [options.label]),
			...OtpField.otpField(
				h,
				config,
				SLOTS.map((slot) =>
					OtpField.otpFieldInput(h, config, slot, undefined, slot === 0 ? [] : [h.AriaLabel(`Digit ${slot + 1} of 6`)]),
				),
			),
		],
	)
}
