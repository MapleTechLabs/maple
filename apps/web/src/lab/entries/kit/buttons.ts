import { Option, Schema } from "effect"
import { Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { button } from "../../../ui/button"
import { cardButton } from "../../../ui/card-button"
import * as CopyButton from "../../../ui/copy-button"
import { badge, kbd, kbdGroup } from "../../../ui/display"
import { filterChip } from "../../../ui/filter-chip"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { inlineCode } from "../../../ui/inline-code"
import { refreshButton } from "../../../ui/refresh-button"
import { statusDot } from "../../../ui/status-dot"
import { textLink } from "../../../ui/text-link"
import * as Toggle from "../../../ui/toggle"
import * as ToggleGroup from "../../../ui/toggle-group"
import { defineLab } from "../../define"
import { kitPage, kitRow, kitSection } from "../../kit/kit-layout"

// `/lab/kit/buttons`.

const VARIANTS = [
	"default",
	"secondary",
	"outline",
	"ghost",
	"destructive",
	"destructive-outline",
	"link",
	"dashed",
] as const
const TEXT_SIZES = ["xs", "sm", "default", "lg", "xl"] as const
const ICON_SIZES = ["icon-2xs", "icon-xs", "icon-sm", "icon", "icon-lg", "icon-xl"] as const
const BADGE_VARIANTS = [
	"default",
	"secondary",
	"outline",
	"muted",
	"meta",
	"destructive",
	"crit",
	"warn",
	"ok",
	"info",
	"done",
	"tag",
] as const
const BADGE_SIZES = ["xs", "sm", "default", "lg"] as const
const TONES = ["crit", "warn", "ok", "info", "done", "neutral", "live"] as const

const TOGGLES = ["wrap", "wrap-pressed", "follow", "follow-pressed", "xs", "sm", "lg", "disabled"] as const
const FILTER_CHIPS = ["errors", "warnings", "ok"] as const
const COPY_BUTTONS = ["trace-id", "ingest-key"] as const

// MODEL

const Model = Schema.Struct({
	toggles: Schema.Record(Schema.String, Toggle.Model),
	toggleGroups: Schema.Record(Schema.String, ToggleGroup.Model),
	filterChips: Schema.Record(Schema.String, Schema.Boolean),
	copyButtons: Schema.Record(Schema.String, CopyButton.Model),
})
type Model = typeof Model.Type

const init = (): Update.Return<Model, Message> => ({
	model: {
		toggles: Object.fromEntries(TOGGLES.map((id) => [id, Toggle.init(id.endsWith("-pressed"))])),
		toggleGroups: {
			window: ToggleGroup.init({ label: "Window", values: ["1h"] }),
			layout: ToggleGroup.init({ label: "Layout", values: ["list"] }),
			signals: ToggleGroup.init({ label: "Signals", isMultiple: true, values: ["logs", "traces"] }),
		},
		filterChips: { errors: true, warnings: false, ok: true },
		copyButtons: Object.fromEntries(COPY_BUTTONS.map((id) => [id, CopyButton.init()])),
	},
})

// MESSAGE

const Message = defineMessageUnion({
	GotToggleMessage: { id: Schema.String, message: Toggle.Message },
	GotToggleGroupMessage: { id: Schema.String, message: ToggleGroup.Message },
	GotCopyButtonMessage: { id: Schema.String, message: CopyButton.Message },
	ClickedFilterChip: { key: Schema.String },
	ClickedRefresh: {},
})
type Message = typeof Message.Type

// UPDATE

const foldToggle = Update.foldChildAt({
	update: Toggle.update,
	readAt: (model: Model, id: string) => Option.fromNullishOr(model.toggles[id]),
	writeAt: (model, id, next) => modifyFields(model, { toggles: (all) => ({ ...all, [id]: next }) }),
	toParentMessage: (id, message) => Message.GotToggleMessage({ id, message }),
})

const foldToggleGroup = Update.foldChildAt({
	update: ToggleGroup.update,
	readAt: (model: Model, id: string) => Option.fromNullishOr(model.toggleGroups[id]),
	writeAt: (model, id, next) => modifyFields(model, { toggleGroups: (all) => ({ ...all, [id]: next }) }),
	toParentMessage: (id, message) => Message.GotToggleGroupMessage({ id, message }),
})

const foldCopyButton = Update.foldChildAt({
	update: CopyButton.update,
	readAt: (model: Model, id: string) => Option.fromNullishOr(model.copyButtons[id]),
	writeAt: (model, id, next) => modifyFields(model, { copyButtons: (all) => ({ ...all, [id]: next }) }),
	toParentMessage: (id, message) => Message.GotCopyButtonMessage({ id, message }),
})

const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		GotToggleMessage: ({ id, message }) => foldToggle(model, id, message),
		GotToggleGroupMessage: ({ id, message }) => foldToggleGroup(model, id, message),
		GotCopyButtonMessage: ({ id, message }) => foldCopyButton(model, id, message),
		ClickedFilterChip: ({ key }) => ({
			model: modifyFields(model, { filterChips: (all) => ({ ...all, [key]: !(all[key] ?? false) }) }),
		}),
		ClickedRefresh: () => ({ model }),
	})

// VIEW

const buttonVariantRows = (h: HtmlBuilder<Message>): ReadonlyArray<Html> =>
	VARIANTS.map((variant) =>
		kitRow(h, variant, [
			...TEXT_SIZES.map((size) => button(h, { variant, size }, [size])),
			...ICON_SIZES.map((size) =>
				button(h, { variant, size, attributes: [h.AriaLabel(`${variant} ${size}`)] }, [
					icon(h, "PlusIcon"),
				]),
			),
		]),
	)

const buttonStates = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		button(h, {}, ["Save changes"]),
		button(h, { variant: "outline" }, ["Cancel edit"]),
		button(h, { isDisabled: true }, ["Disabled"]),
		button(h, { variant: "outline", isDisabled: true }, ["Disabled outline"]),
		button(h, { isLoading: true }, ["Save changes"]),
		button(h, { variant: "outline", isLoading: true }, ["Save changes"]),
		button(h, { variant: "outline" }, [icon(h, "PlusIcon"), " With icon"]),
	])

const iconButtons = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		iconButton(h, { label: "Add widget", triggerId: "base-ui-_r_1_" }, [icon(h, "PlusIcon")]),
		iconButton(h, { label: "Delete row", variant: "outline", triggerId: "base-ui-_r_3_" }, [
			icon(h, "TrashIcon"),
		]),
		iconButton(h, { label: "Notifications", size: "icon", triggerId: "base-ui-_r_5_" }, [
			icon(h, "BellIcon"),
		]),
		iconButton(h, { label: "Filters disabled", isDisabled: true, triggerId: "base-ui-_r_7_" }, [
			icon(h, "FilterIcon"),
		]),
	])

const toggleOf = (
	model: Model,
	h: HtmlBuilder<Message>,
	id: (typeof TOGGLES)[number],
	options: Omit<Toggle.ToggleOptions<Message>, "isPressed" | "onClick">,
	label: string,
): Html =>
	Toggle.toggle(
		h,
		{
			...options,
			isPressed: model.toggles[id]?.isPressed ?? false,
			onClick: Message.GotToggleMessage({ id, message: Toggle.Message.ClickedToggle() }),
		},
		[label],
	)

const toggles = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		toggleOf(model, h, "wrap", { attributes: [h.AriaLabel("Wrap lines")] }, "Wrap"),
		toggleOf(model, h, "wrap-pressed", { attributes: [h.AriaLabel("Wrap lines pressed")] }, "Wrap"),
		toggleOf(
			model,
			h,
			"follow",
			{ variant: "outline", attributes: [h.AriaLabel("Follow tail")] },
			"Follow",
		),
		toggleOf(
			model,
			h,
			"follow-pressed",
			{ variant: "outline", attributes: [h.AriaLabel("Follow tail pressed")] },
			"Follow",
		),
		toggleOf(model, h, "xs", { size: "xs" }, "xs"),
		toggleOf(model, h, "sm", { size: "sm" }, "sm"),
		toggleOf(model, h, "lg", { size: "lg" }, "lg"),
		toggleOf(model, h, "disabled", { isDisabled: true }, "Disabled"),
	])

const toggleGroupOf = (
	model: Model,
	h: HtmlBuilder<Message>,
	id: string,
	config: Omit<ToggleGroup.ToggleGroupViewConfig<Message>, "model" | "toParentMessage">,
): ReadonlyArray<Html> => {
	const group = model.toggleGroups[id]
	if (group === undefined) return []
	return [
		ToggleGroup.view(h, {
			...config,
			model: group,
			toParentMessage: (message) => Message.GotToggleGroupMessage({ id, message }),
		}),
	]
}

const items = (...labels: ReadonlyArray<readonly [string, string]>) =>
	labels.map(([value, label]) => ({ value, label }))

const toggleGroups = (model: Model, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	kitRow(
		h,
		"outline (track)",
		toggleGroupOf(model, h, "window", {
			variant: "outline",
			items: items(["15m", "15m"], ["1h", "1h"], ["24h", "24h"], ["7d", "7d"]),
		}),
	),
	kitRow(
		h,
		"default",
		toggleGroupOf(model, h, "layout", { items: items(["list", "List"], ["grid", "Grid"]) }),
	),
	kitRow(
		h,
		"standalone, sm",
		toggleGroupOf(model, h, "signals", {
			variant: "outline",
			isConnected: false,
			size: "sm",
			items: items(["logs", "Logs"], ["traces", "Traces"], ["metrics", "Metrics"]),
		}),
	),
]

const copyButtonOf = (
	model: Model,
	h: HtmlBuilder<Message>,
	id: (typeof COPY_BUTTONS)[number],
	config: Omit<CopyButton.CopyButtonViewConfig<Message>, "model" | "toParentMessage">,
): ReadonlyArray<Html> => {
	const copy = model.copyButtons[id]
	if (copy === undefined) return []
	return [
		CopyButton.view(h, {
			...config,
			model: copy,
			toParentMessage: (message) => Message.GotCopyButtonMessage({ id, message }),
		}),
	]
}

const copyAndRefresh = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		...copyButtonOf(model, h, "trace-id", {
			value: "4bf92f3577b34da6a3ce929d0e0e4736",
			label: "trace id",
		}),
		...copyButtonOf(model, h, "ingest-key", {
			value: "maple_ingest_key",
			label: "ingest key",
			idleLabel: "Copy",
			variant: "outline",
		}),
		refreshButton(h, { onRefresh: Message.ClickedRefresh() }),
		refreshButton(h, { onRefresh: Message.ClickedRefresh(), isPending: true, label: "Refreshing" }),
		refreshButton(h, {
			onRefresh: Message.ClickedRefresh(),
			isIconOnly: true,
			label: "Reload data",
			triggerId: "base-ui-_r_q_",
		}),
	])

const filterChips = (model: Model, h: HtmlBuilder<Message>): Html => {
	const isPressed = (key: (typeof FILTER_CHIPS)[number]) => model.filterChips[key] ?? false
	const onClick = (key: (typeof FILTER_CHIPS)[number]) => Message.ClickedFilterChip({ key })
	return kitRow(h, undefined, [
		filterChip(
			h,
			{
				isPressed: isPressed("errors"),
				onClick: onClick("errors"),
				tone: "crit",
				hasDot: true,
				count: "12",
			},
			["Errors"],
		),
		filterChip(
			h,
			{
				isPressed: isPressed("warnings"),
				onClick: onClick("warnings"),
				tone: "warn",
				hasDot: true,
				count: "4",
			},
			["Warnings"],
		),
		filterChip(h, { isPressed: isPressed("ok"), onClick: onClick("ok"), tone: "ok", size: "xs" }, [
			"Healthy",
		]),
	])
}

const badges = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	kitRow(
		h,
		"variants",
		BADGE_VARIANTS.map((variant) => badge(h, { variant }, [variant])),
	),
	kitRow(h, "sizes, pill, mono", [
		...BADGE_SIZES.map((size) => badge(h, { size, variant: "secondary" }, [size])),
		badge(h, { pill: true, variant: "muted" }, ["pill"]),
		badge(h, { mono: true, variant: "outline" }, ["12,480"]),
	]),
]

const statusDots = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		...TONES.map((tone) =>
			h.span([h.Class("flex items-center gap-1.5 text-xs")], [statusDot(h, { tone }), ` ${tone}`]),
		),
		statusDot(h, { tone: "crit", size: "sm" }),
		statusDot(h, { tone: "crit", size: "lg" }),
	])

const kbdAndInlineCode = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		kbd(h, undefined, ["K"]),
		kbdGroup(h, undefined, [
			kbd(h, undefined, ["Cmd"]),
			kbd(h, undefined, ["Shift"]),
			kbd(h, undefined, ["P"]),
		]),
		h.span(
			[h.Class("text-sm")],
			[
				"Set ",
				inlineCode(h, {}, ["service.name"]),
				" or run ",
				inlineCode(h, { variant: "plain" }, ["maple login"]),
				".",
			],
		),
	])

const textLinks = (h: HtmlBuilder<Message>): Html =>
	kitRow(h, undefined, [
		textLink(h, { onClick: Message.ClickedRefresh() }, ["View all →"]),
		textLink(h, { href: "#text-link" }, ["Open settings"]),
		textLink(h, { tone: "muted", onClick: Message.ClickedRefresh() }, ["Clear filters"]),
		textLink(
			h,
			{ tone: "muted", isMono: true, className: "text-3xs", onClick: Message.ClickedRefresh() },
			["+4 more"],
		),
		textLink(h, { onClick: Message.ClickedRefresh(), isDisabled: true }, ["Disabled"]),
	])

const cardButtons = (h: HtmlBuilder<Message>): Html =>
	kitRow(
		h,
		undefined,
		(
			[
				["Resting", false, false],
				["Selected", true, false],
				["Disabled", false, true],
			] as const
		).map(([title, isSelected, isDisabled]) =>
			cardButton(
				h,
				{
					onClick: Message.ClickedRefresh(),
					isSelected,
					isDisabled,
					className: "flex w-56 flex-col gap-1 p-3",
				},
				[
					h.span([h.Class("text-sm font-medium")], [title]),
					h.span([h.Class("text-xs text-muted-foreground")], ["A whole card as one click target."]),
				],
			),
		),
	)

const view = (model: Model, h: HtmlBuilder<Message>): Html =>
	kitPage(
		h,
		{
			title: "Kit: buttons",
			description: "Buttons, toggles, chips, badges and inline marks from @maple/ui.",
		},
		[
			kitSection(h, "Button variants x sizes", buttonVariantRows(h)),
			kitSection(h, "Button states", [buttonStates(h)]),
			kitSection(h, "Icon button", [iconButtons(h)]),
			kitSection(h, "Text link", [textLinks(h)]),
			kitSection(h, "Card button", [cardButtons(h)]),
			kitSection(h, "Toggle", [toggles(model, h)]),
			kitSection(h, "Toggle group", toggleGroups(model, h)),
			kitSection(h, "Copy and refresh buttons", [copyAndRefresh(model, h)]),
			kitSection(h, "Filter chip", [filterChips(model, h)]),
			kitSection(h, "Badge", badges(h)),
			kitSection(h, "Status dot", [statusDots(h)]),
			kitSection(h, "Kbd and inline code", [kbdAndInlineCode(h)]),
		],
	)

export const lab = defineLab("Kit: buttons", { Model, init, update, view })
