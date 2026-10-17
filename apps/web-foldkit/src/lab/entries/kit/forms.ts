import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import * as Autocomplete from "../../../ui/autocomplete"
import * as Checkbox from "../../../ui/checkbox"
import * as Combobox from "../../../ui/combobox"
import * as Field from "../../../ui/field"
import { icon } from "../../../ui/icon"
import { input } from "../../../ui/input"
import {
	inputGroup,
	inputGroupAddon,
	inputGroupButton,
	inputGroupInput,
	inputGroupText,
} from "../../../ui/input-group"
import { label } from "../../../ui/label"
import { nativeOptGroup, nativeOption, nativeSelect } from "../../../ui/native-select"
import * as OtpField from "../../../ui/otp-field"
import * as RadioGroup from "../../../ui/radio-group"
import * as Select from "../../../ui/select"
import * as Switch from "../../../ui/switch"
import { textarea } from "../../../ui/textarea"
import { defineLab } from "../../define"
import { kitPage, kitRow, kitSection } from "../../kit/kit-layout"

// Port of `/lab/kit/forms` (apps/web/src/lab/kit/forms.tsx, pickers.tsx). Ids are the `useId`s
// Base UI gives each control in apps/web, so the two DOMs diff clean.

const INPUT_SIZES = ["sm", "default", "lg"] as const
const SERVICES = ["api-gateway", "checkout-svc", "payment-svc", "inventory-svc", "notification-svc"]
const ENVIRONMENTS: ReadonlyArray<Select.SelectOption> = [
	{ value: "production", label: "Production" },
	{ value: "staging", label: "Staging" },
	{ value: "development", label: "Development" },
]
const CHECKBOXES = [
	{ key: "unchecked", id: "base-ui-_r_j_", inputId: "base-ui-_r_k_", text: "Unchecked" },
	{ key: "checked", id: "base-ui-_r_m_", inputId: "base-ui-_r_n_", text: "Checked" },
	{ key: "indeterminate", id: "base-ui-_r_p_", inputId: "base-ui-_r_q_", text: "Indeterminate" },
	{ key: "disabled", id: "base-ui-_r_s_", inputId: "base-ui-_r_t_", text: "Disabled" },
] as const
const SWITCHES = [
	{ key: "off", id: "base-ui-_r_1c_", inputId: "base-ui-_r_1d_", text: "Off" },
	{ key: "on", id: "base-ui-_r_1f_", inputId: "base-ui-_r_1g_", text: "On" },
	{ key: "disabled", id: "base-ui-_r_1i_", inputId: "base-ui-_r_1j_", text: "Disabled" },
] as const
const RADIOS: ReadonlyArray<RadioGroup.RadioItem> = [
	{ value: "p50", id: "base-ui-_r_10_", inputId: "base-ui-_r_11_" },
	{ value: "p95", id: "base-ui-_r_13_", inputId: "base-ui-_r_14_" },
	{ value: "p99", id: "base-ui-_r_16_", inputId: "base-ui-_r_17_" },
	{ value: "max", id: "base-ui-_r_19_", inputId: "base-ui-_r_1a_", isDisabled: true },
]
const DASHBOARD_FIELD: Field.FieldIds = {
	control: "base-ui-_r_b_",
	label: "base-ui-_r_c_",
	error: "base-ui-_r_d_",
	description: "base-ui-_r_e_",
}
const WEBHOOK_FIELD: Field.FieldIds = {
	control: "base-ui-_r_f_",
	label: "base-ui-_r_g_",
	error: "base-ui-_r_i_",
}

// MODEL

const Model = Schema.Struct({
	fields: Schema.Record(Schema.String, Field.Model),
	checkboxes: Schema.Record(Schema.String, Checkbox.Model),
	switches: Schema.Record(Schema.String, Switch.Model),
	radioGroup: RadioGroup.Model,
	select: Select.Model,
	comboboxes: Schema.Record(Schema.String, Combobox.Model),
	otpField: OtpField.Model,
})
type Model = typeof Model.Type

const init = (): Update.Return<Model, Message> => ({
	model: {
		fields: { dashboard: Field.init("Checkout latency"), webhook: Field.init("hooks.example") },
		checkboxes: Object.fromEntries(CHECKBOXES.map(({ key }) => [key, Checkbox.init(key === "checked")])),
		switches: Object.fromEntries(SWITCHES.map(({ key }) => [key, Switch.init(key === "on")])),
		radioGroup: RadioGroup.init("p95"),
		select: Select.init({ values: ENVIRONMENTS.map((option) => option.value), value: "staging" }),
		comboboxes: {
			service: Combobox.init({ mode: "single", items: SERVICES, selected: ["payment-svc"] }),
			services: Combobox.init({
				mode: "multiple",
				items: SERVICES,
				selected: ["checkout-svc", "payment-svc"],
			}),
			search: Combobox.init({ mode: "autocomplete", items: SERVICES }),
		},
		otpField: OtpField.init({ id: "base-ui-_r_22_", length: 6, value: "482" }),
	},
})

// MESSAGE

const Message = defineMessageUnion({
	GotFieldMessage: { key: Schema.String, message: Field.Message },
	GotCheckboxMessage: { key: Schema.String, message: Checkbox.Message },
	GotSwitchMessage: { key: Schema.String, message: Switch.Message },
	GotRadioGroupMessage: { message: RadioGroup.Message },
	GotSelectMessage: { message: Select.Message },
	GotComboboxMessage: { key: Schema.String, message: Combobox.Message },
	GotOtpFieldMessage: { message: OtpField.Message },
	ClickedClearSearch: {},
})
type Message = typeof Message.Type

// UPDATE

const foldField = Update.foldChildAt({
	update: Field.update,
	readAt: (model: Model, key: string) => Option.fromNullishOr(model.fields[key]),
	writeAt: (model, key, next) => modifyFields(model, { fields: (all) => ({ ...all, [key]: next }) }),
	toParentMessage: (key, message) => Message.GotFieldMessage({ key, message }),
})

const foldCheckbox = Update.foldChildAt({
	update: Checkbox.update,
	readAt: (model: Model, key: string) => Option.fromNullishOr(model.checkboxes[key]),
	writeAt: (model, key, next) => modifyFields(model, { checkboxes: (all) => ({ ...all, [key]: next }) }),
	toParentMessage: (key, message) => Message.GotCheckboxMessage({ key, message }),
})

const foldSwitch = Update.foldChildAt({
	update: Switch.update,
	readAt: (model: Model, key: string) => Option.fromNullishOr(model.switches[key]),
	writeAt: (model, key, next) => modifyFields(model, { switches: (all) => ({ ...all, [key]: next }) }),
	toParentMessage: (key, message) => Message.GotSwitchMessage({ key, message }),
})

const foldCombobox = Update.foldChildAt({
	update: Combobox.update,
	readAt: (model: Model, key: string) => Option.fromNullishOr(model.comboboxes[key]),
	writeAt: (model, key, next) => modifyFields(model, { comboboxes: (all) => ({ ...all, [key]: next }) }),
	toParentMessage: (key, message) => Message.GotComboboxMessage({ key, message }),
})

const foldRadioGroup = Update.foldChild({
	update: RadioGroup.update,
	read: (model: Model) => Option.some(model.radioGroup),
	write: (model, next) => modifyFields(model, { radioGroup: () => next }),
	toParentMessage: (message: RadioGroup.Message) => Message.GotRadioGroupMessage({ message }),
})

const foldSelect = Update.foldChild({
	update: Select.update,
	read: (model: Model) => Option.some(model.select),
	write: (model, next) => modifyFields(model, { select: () => next }),
	toParentMessage: (message: Select.Message) => Message.GotSelectMessage({ message }),
})

const foldOtpField = Update.foldChild({
	update: OtpField.update,
	read: (model: Model) => Option.some(model.otpField),
	write: (model, next) => modifyFields(model, { otpField: () => next }),
	toParentMessage: (message: OtpField.Message) => Message.GotOtpFieldMessage({ message }),
})

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotFieldMessage: ({ key, message }) => foldField(model, key, message),
		GotCheckboxMessage: ({ key, message }) => foldCheckbox(model, key, message),
		GotSwitchMessage: ({ key, message }) => foldSwitch(model, key, message),
		GotRadioGroupMessage: ({ message }) => foldRadioGroup(model, message),
		GotSelectMessage: ({ message }) => foldSelect(model, message),
		GotComboboxMessage: ({ key, message }) => foldCombobox(model, key, message),
		GotOtpFieldMessage: ({ message }) => foldOtpField(model, message),
		// The legacy clear button has no handler either.
		ClickedClearSearch: () => ({ model }),
	})

// VIEW

const inputs = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	kitRow(
		h,
		"sizes",
		INPUT_SIZES.map((size, index) =>
			input(h, {
				id: `base-ui-_r_${index}_`,
				size,
				className: "w-48",
				attributes: [h.AriaLabel(`Input ${size}`), h.Placeholder(`Size ${size}`)],
			}),
		),
	),
	kitRow(h, "states", [
		input(h, {
			id: "base-ui-_r_3_",
			className: "w-48",
			attributes: [h.AriaLabel("Service name"), h.Value("checkout-svc")],
		}),
		input(h, {
			id: "base-ui-_r_4_",
			className: "w-48",
			attributes: [h.AriaInvalid(true), h.AriaLabel("Invalid input"), h.Value("not a url")],
		}),
		input(h, {
			id: "base-ui-_r_5_",
			className: "w-48",
			isDisabled: true,
			attributes: [h.AriaLabel("Disabled input"), h.Value("read only")],
		}),
	]),
]

const textareas = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		textarea(h, {
			id: "base-ui-_r_6_",
			className: "w-72",
			attributes: [h.AriaLabel("Notes"), h.Placeholder("Describe the incident")],
		}),
		textarea(h, {
			id: "base-ui-_r_7_",
			className: "w-72",
			defaultValue: "Too short",
			attributes: [h.AriaInvalid(true), h.AriaLabel("Invalid notes")],
		}),
		textarea(h, {
			id: "base-ui-_r_8_",
			className: "w-72",
			isDisabled: true,
			defaultValue: "Locked",
			attributes: [h.AriaLabel("Disabled notes")],
		}),
	])

const inputGroups = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		inputGroup(h, { className: "w-72" }, [
			inputGroupAddon(h, {}, [icon(h, "MagnifierIcon")]),
			inputGroupInput(h, {
				id: "base-ui-_r_9_",
				attributes: [h.AriaLabel("Search spans"), h.Placeholder("Search spans")],
			}),
			inputGroupAddon(h, { align: "inline-end" }, [
				inputGroupButton(
					h,
					{
						size: "icon-xs",
						attributes: [h.AriaLabel("Clear search"), h.OnClick(Message.ClickedClearSearch())],
					},
					[icon(h, "XmarkIcon")],
				),
			]),
		]),
		inputGroup(h, { className: "w-72" }, [
			inputGroupAddon(h, {}, [inputGroupText(h, {}, ["https://"])]),
			inputGroupInput(h, {
				id: "base-ui-_r_a_",
				attributes: [h.AriaLabel("Endpoint"), h.Value("ingest.maple.dev")],
			}),
			inputGroupAddon(h, { align: "inline-end" }, [inputGroupText(h, {}, ["/v1/traces"])]),
		]),
	])

const fieldOf = (
	model: Model,
	h: HtmlBuilder<Message>,
	key: string,
	ids: Field.FieldIds,
	isInvalid: boolean,
	labelText: string,
	trailing: (state: Field.FieldState) => Html,
): ReadonlyArray<Html> => {
	const fieldModel = model.fields[key]
	if (fieldModel === undefined) return []
	const state = Field.stateOf(fieldModel, isInvalid)
	const toParentMessage = (message: Field.Message) => Message.GotFieldMessage({ key, message })
	return [
		Field.field(h, { state }, [
			Field.fieldLabel(h, { ids, state }, labelText),
			Field.input(h, {
				ids,
				state,
				attributes: Field.controlAttributes(h, fieldModel, toParentMessage),
			}),
			trailing(state),
		]),
	]
}

const fields = (model: Model, h: HtmlBuilder<Message>): Html =>
	h.div(
		[h.Class("grid max-w-3xl grid-cols-2 gap-6")],
		[
			...fieldOf(model, h, "dashboard", DASHBOARD_FIELD, false, "Dashboard name", (state) =>
				Field.fieldDescription(
					h,
					{ ids: DASHBOARD_FIELD, state },
					"Shown in the sidebar and in alert notifications.",
				),
			),
			...fieldOf(model, h, "webhook", WEBHOOK_FIELD, true, "Webhook URL", (state) =>
				Field.fieldError(h, { ids: WEBHOOK_FIELD, state }, "Enter a full URL starting with https://"),
			),
		],
	)

const CHOICE_LABEL = "flex items-center gap-2"

const choiceLabel = (
	h: HtmlBuilder<Message>,
	inputId: string,
	control: ReadonlyArray<Html>,
	text: string,
): Html =>
	label(h, { className: CHOICE_LABEL, attributes: [h.Id(`${inputId}-label`)] }, [...control, ` ${text}`])

const checkboxes = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitRow(
		h,
		"checkbox",
		CHECKBOXES.flatMap(({ key, id, inputId, text }) => {
			const checkbox = model.checkboxes[key]
			if (checkbox === undefined) return []
			const control = Checkbox.view(h, {
				model: checkbox,
				toParentMessage: (message) => Message.GotCheckboxMessage({ key, message }),
				id,
				inputId,
				isIndeterminate: key === "indeterminate",
				isDisabled: key === "disabled",
			})
			return [choiceLabel(h, inputId, control, text)]
		}),
	)

const radios = (model: Model, h: HtmlBuilder<Message>): Html => {
	const config: RadioGroup.RadioGroupViewConfig<Message> = {
		model: model.radioGroup,
		toParentMessage: (message) => Message.GotRadioGroupMessage({ message }),
		items: RADIOS,
	}
	return kitRow(h, "radio group", [
		RadioGroup.radioGroup(
			h,
			{ label: "Percentile", className: "flex flex-row gap-4" },
			RADIOS.map((item) =>
				choiceLabel(h, item.inputId, RadioGroup.radio(h, config, item.value), item.value),
			),
		),
	])
}

const switches = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitRow(
		h,
		"switch",
		SWITCHES.flatMap(({ key, id, inputId, text }) => {
			const switchModel = model.switches[key]
			if (switchModel === undefined) return []
			const control = Switch.view(h, {
				model: switchModel,
				toParentMessage: (message) => Message.GotSwitchMessage({ key, message }),
				id,
				inputId,
				isDisabled: key === "disabled",
			})
			return [choiceLabel(h, inputId, control, text)]
		}),
	)

const nativeSelects = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		nativeSelect(h, { className: "w-48", defaultValue: "us", attributes: [h.AriaLabel("Region")] }, [
			nativeOptGroup("Regions", [
				{ value: "us", label: "United States" },
				{ value: "eu", label: "Europe" },
			]),
		]),
		nativeSelect(
			h,
			{ className: "w-48", size: "sm", defaultValue: "eu", attributes: [h.AriaLabel("Small region")] },
			[nativeOption("us", "United States"), nativeOption("eu", "Europe")],
		),
		nativeSelect(
			h,
			{ className: "w-48", isDisabled: true, attributes: [h.AriaLabel("Disabled region")] },
			[nativeOption("us", "United States")],
		),
	])

const comboboxConfig = (model: Model, key: string) =>
	Option.map(Option.fromNullishOr(model.comboboxes[key]), (combobox) => ({
		model: combobox,
		toParentMessage: (message: Combobox.Message) => Message.GotComboboxMessage({ key, message }),
	}))

const w64 = (h: HtmlBuilder<Message>) => (group: Html) => h.div([h.Class("w-64")], [group])

const pickers = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	kitRow(h, undefined, [
		...Select.view(h, {
			model: model.select,
			toParentMessage: (message) => Message.GotSelectMessage({ message }),
			id: "base-ui-_r_1l_",
			label: "Environment",
			className: "w-56",
			entries: [
				{
					_tag: "Group",
					label: "Deployed",
					labelId: "base-ui-_r_1n_",
					options: ENVIRONMENTS.slice(0, 2),
				},
				{ _tag: "Separator" },
				...ENVIRONMENTS.slice(2).map((option) => ({ _tag: "Option" as const, option })),
			],
		}),
		...Option.match(comboboxConfig(model, "service"), {
			onNone: () => [],
			onSome: (config) =>
				Combobox.view(h, {
					...config,
					id: "base-ui-_r_1o_",
					label: "Service",
					placeholder: "Pick a service",
					emptyText: "No services found.",
					startAddon: icon(h, "MagnifierIcon"),
					wrap: w64(h),
				}),
		}),
		...Option.match(comboboxConfig(model, "search"), {
			onNone: () => [],
			onSome: (config) =>
				Autocomplete.view(h, {
					...config,
					id: "base-ui-_r_1s_",
					label: "Search services",
					placeholder: "Search services",
					emptyText: "No matches.",
					startAddon: icon(h, "MagnifierIcon"),
					wrap: w64(h),
				}),
		}),
	]),
	kitRow(
		h,
		undefined,
		Option.match(comboboxConfig(model, "services"), {
			onNone: () => [],
			onSome: (config) =>
				Combobox.chipsView(h, {
					...config,
					id: "base-ui-_r_1v_",
					label: "Services",
					placeholder: "Add a service",
					emptyText: "No services found.",
					className: "w-96",
				}),
		}),
	),
]

const otpField = (model: Model, h: HtmlBuilder<Message>): Html => {
	const config: OtpField.OtpFieldViewConfig<Message> = {
		model: model.otpField,
		toParentMessage: (message) => Message.GotOtpFieldMessage({ message }),
		label: "Verification code",
	}
	const slot = (index: number) => OtpField.otpFieldInput(h, config, index)
	return kitRow(h, undefined, [
		...OtpField.otpField(h, config, [
			slot(0),
			slot(1),
			slot(2),
			OtpField.otpFieldSeparator(h),
			slot(3),
			slot(4),
			slot(5),
		]),
		label(h, {}, ["Standalone label"]),
	])
}

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitPage(
		h,
		{
			title: "Kit: forms",
			description: "Inputs, fields and choice controls from @maple/ui, every picker closed.",
		},
		[
			kitSection(h, "Input", inputs(h)),
			kitSection(h, "Textarea", [textareas(h)]),
			kitSection(h, "Input group", [inputGroups(h)]),
			kitSection(h, "Field", [fields(model, h)]),
			kitSection(h, "Checkbox, radio group, switch", [
				checkboxes(model, h),
				radios(model, h),
				switches(model, h),
			]),
			kitSection(h, "Native select", [nativeSelects(h)]),
			kitSection(h, "Select, combobox, autocomplete (closed)", pickers(model, h)),
			kitSection(h, "OTP field and label", [otpField(model, h)]),
		],
	)

export const lab = defineLab("Kit: forms", { Model, init, update, view })
