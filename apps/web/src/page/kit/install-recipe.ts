import type { Lang } from "@maple/views/lib/highlight"
import { Array as Arr, Option, Schema, String as Str } from "effect"
import { Command, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { button } from "@maple/views/ui/button"
import * as CopyButton from "@maple/views/ui/copy-button"
import { icon } from "@maple/views/ui/icon"
import { inlineCode } from "@maple/views/ui/inline-code"
import { skeleton } from "@maple/views/ui/skeleton"
import { typography } from "@maple/views/ui/typography"
import { codeBlock } from "./code-block"
import { methodPicker } from "./method-picker"
import { setupStep, setupSteps } from "./setup-steps"
import { ToolId } from "./tool-marks"

// An install as data: per tool, the files to save and the commands that carry the key. One view draws
// every recipe the same way (the collector dialog, a Kubernetes source), with the key masked until revealed.

/** A run of hint text; `{ code }` shows as inline code. */
export type HintPart = string | Readonly<{ code: string }>

export type RecipeStep =
	| Readonly<{
			_tag: "File"
			/** Unique across the recipes shown together: it keys the step's copy button and fold. */
			id: string
			name: string
			lang: Lang
			text: string
			hint?: ReadonlyArray<HintPart>
	  }>
	| Readonly<{
			_tag: "Command"
			id: string
			title: string
			hint?: ReadonlyArray<HintPart>
			/** The command with the key in it. */
			build: (key: string) => string
	  }>

export type InstallRecipe = Readonly<{ tool: ToolId; steps: ReadonlyArray<RecipeStep> }>

export const fileStep = (step: Omit<Extract<RecipeStep, { _tag: "File" }>, "_tag">): RecipeStep => ({
	_tag: "File",
	...step,
})

export const commandStep = (step: Omit<Extract<RecipeStep, { _tag: "Command" }>, "_tag">): RecipeStep => ({
	_tag: "Command",
	...step,
})

const MASK = Str.repeat(20)("•")

/** A key as it shows masked: its type prefix (`maple_sk_`), then dots. */
export const maskSecret = (key: string): string => {
	const prefix = /^[a-z]+_[a-z]+_/.exec(key)?.[0]
	return `${prefix ?? ""}${MASK}`
}

/** Stands in for a key that can no longer be shown, from the prefix stored with it. */
export const maskedSecret = (prefix: string | null): string => `${prefix ?? ""}${MASK}`

export const Model = Schema.Struct({
	/** The picked tool; one the recipes shown lack falls back to their first. */
	method: Schema.NullOr(ToolId),
	isRevealed: Schema.Boolean,
	/** The files shown whole; the others show their first lines. */
	openFiles: Schema.Array(Schema.String),
	copies: Schema.Record(Schema.String, CopyButton.Model),
})
export type Model = typeof Model.Type

export const init = (): Model => ({ method: null, isRevealed: false, openFiles: [], copies: {} })

export const Message = defineMessageUnion({
	ClickedMethod: { method: ToolId },
	ClickedToggleReveal: {},
	ClickedToggleFile: { id: Schema.String },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedMethod: ({ method }) => ({ model: { ...model, method } }),
		ClickedToggleReveal: () => ({ model: { ...model, isRevealed: !model.isRevealed } }),
		ClickedToggleFile: ({ id }) => ({
			model: {
				...model,
				openFiles: model.openFiles.includes(id)
					? Arr.filter(model.openFiles, (open) => open !== id)
					: [...model.openFiles, id],
			},
		}),
		GotCopyMessage: ({ id, message: inner }) => {
			const next = CopyButton.update(model.copies[id] ?? CopyButton.init(), inner)
			return {
				model: { ...model, copies: { ...model.copies, [id]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (message) =>
					Message.GotCopyMessage({ id, message }),
				),
			}
		},
	})

/** The recipe the picker points at. */
export const selectedRecipe = (
	model: Model,
	recipes: ReadonlyArray<InstallRecipe>,
): InstallRecipe | undefined =>
	Option.getOrElse(
		Arr.findFirst(recipes, (recipe) => recipe.tool === model.method),
		() => recipes[0],
	)

/**
 * The key the commands carry. `masked` is what shows until revealed; without it the key shows as is
 * (a token shown once, or one already masked for good).
 */
export type RecipeKey = Readonly<{ isLoading: boolean; value: string; masked?: string }>

export type RecipeViewConfig<P> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => P
	recipes: ReadonlyArray<InstallRecipe>
	key: RecipeKey
	/** Sits under each command that carries the key. */
	keyNote?: ReadonlyArray<Html | string>
	/** The picker's label when there is more than one recipe. */
	pickerLabel?: string
	/** How many lines a file shows until opened. */
	foldLines?: number
}>

const hintOf = <P>(h: HtmlBuilder<P>, parts: ReadonlyArray<HintPart>): ReadonlyArray<Html | string> =>
	Arr.map(parts, (part) => (typeof part === "string" ? part : inlineCode(h, {}, [part.code])))

const revealButton = <P>(h: HtmlBuilder<P>, config: RecipeViewConfig<P>): Html => {
	const label = config.model.isRevealed ? "Hide key" : "Reveal key"
	return button(
		h,
		{
			variant: "ghost",
			size: "xs",
			attributes: [
				h.AriaLabel(label),
				h.OnClick(config.toParentMessage(Message.ClickedToggleReveal())),
			],
		},
		[icon(h, "EyeIcon", { size: 12 }), label],
	)
}

const copyOf = <P>(config: RecipeViewConfig<P>, id: string) => ({
	copy: config.model.copies[id] ?? CopyButton.init(),
	toCopyMessage: (message: CopyButton.Message) =>
		config.toParentMessage(Message.GotCopyMessage({ id, message })),
})

const stepView = <P>(h: HtmlBuilder<P>, config: RecipeViewConfig<P>, step: RecipeStep): Html => {
	const hint = step.hint === undefined ? undefined : hintOf(h, step.hint)
	if (step._tag === "File")
		return setupStep(h, { title: ["Save this as ", inlineCode(h, {}, [step.name])], hint }, [
			codeBlock(h, {
				code: step.text,
				fileName: step.name,
				lang: step.lang,
				...copyOf(config, step.id),
				fold: {
					isOpen: config.model.openFiles.includes(step.id),
					lines: config.foldLines ?? 12,
					onToggle: config.toParentMessage(Message.ClickedToggleFile({ id: step.id })),
				},
			}),
		])
	const { key } = config
	const canReveal = key.masked !== undefined
	const isShown = !canReveal || config.model.isRevealed
	return setupStep(h, { title: [step.title], hint }, [
		key.isLoading
			? skeleton(h, "h-16 w-full")
			: codeBlock(h, {
					code: step.build(isShown ? key.value : (key.masked ?? key.value)),
					copyValue: step.build(key.value),
					language: "shell",
					lang: "shell",
					secret: isShown,
					...copyOf(config, step.id),
					actions: canReveal ? [revealButton(h, config)] : undefined,
				}),
		...(config.keyNote === undefined
			? []
			: [typography(h, { size: "xs", tone: "muted", as: "p" }, config.keyNote)]),
	])
}

/** The picker (with two recipes or more) and the picked recipe's steps. */
export const view = <P>(h: HtmlBuilder<P>, config: RecipeViewConfig<P>): ReadonlyArray<Html> => {
	const recipe = selectedRecipe(config.model, config.recipes)
	if (recipe === undefined) return []
	return [
		...(config.recipes.length > 1
			? [
					methodPicker(h, {
						label: config.pickerLabel ?? "Install with",
						methods: Arr.map(config.recipes, (entry) => entry.tool),
						value: recipe.tool,
						onChange: (method) => config.toParentMessage(Message.ClickedMethod({ method })),
					}),
				]
			: []),
		setupSteps(
			h,
			Arr.map(recipe.steps, (step) => stepView(h, config, step)),
		),
	]
}
