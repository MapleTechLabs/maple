import { isPublicSourcePlatform, isPushSourcePlatform, type SourcePlatform } from "@maple/primitives"
import { String as Str } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button, linkButton } from "@maple/views/ui/button"
import { collapsible } from "@maple/views/ui/collapsible"
import { copyableField } from "@maple/views/ui/copyable-field"
import { type FieldIds, type FieldState, field, fieldLabel, input } from "@maple/views/ui/field"
import { icon } from "@maple/views/ui/icon"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { flowColumns, statusRow, stepCard } from "../../kit/connect-flow"
import { defaultSourceName } from "../kit/platforms"
import { rulesOutcome } from "../kit/rules"
import * as RulesView from "../kit/rules-view"
import * as Setup from "../kit/setup"
import { sourceHref } from "../kit/shared"
import { Message } from "./message"
import type { Created, FlowHost, Model } from "./model"
import { isReceiving } from "./update"
import { flowFooter } from "./view-footer"
import { showsUpRail } from "./view-push-rail"

// A push source on one page: name it, Create, and the token lands in the snippet under the name.

type H = HtmlBuilder<Message>

const NAME_IDS: FieldIds = { control: "source-name", label: "source-name-label", error: "source-name-error" }
const ADVANCED_PANEL_ID = "source-advanced-panel"

const note = (h: H, text: string): Html => typography(h, { size: "xs", tone: "muted", as: "p" }, [text])

/** Editable until Create answers; the created source's name after it (renamed in its settings). */
const nameField = (h: H, model: Model, platform: SourcePlatform, created: Created | null): Html => {
	const value = created === null ? model.name : created.source.name
	const state: FieldState = {
		isInvalid: false,
		isDirty: value !== defaultSourceName(platform),
		isFilled: value !== "",
		isFocused: false,
		isTouched: false,
	}
	return field(h, { state }, [
		fieldLabel(h, { ids: NAME_IDS, state }, "Name"),
		input(h, {
			ids: NAME_IDS,
			state,
			isDisabled: created !== null,
			attributes: [
				h.Value(value),
				h.Attribute("maxlength", "100"),
				h.OnInput((next) => Message.ChangedName({ value: next })),
			],
		}),
	])
}

const advanced = (h: H, model: Model): Html =>
	collapsible(
		h,
		{
			isOpen: model.isAdvancedOpen,
			onToggle: Message.ToggledAdvanced(),
			panelId: ADVANCED_PANEL_ID,
			triggerClassName:
				"text-muted-foreground hover:text-foreground active:text-foreground group flex items-center gap-1.5 text-sm",
			trigger: [
				icon(h, "ChevronRightIcon", {
					size: 14,
					className: "transition-transform group-data-[panel-open]:rotate-90",
				}),
				"Advanced",
			],
		},
		[
			h.div(
				[h.Class("mt-4 border-t border-border pt-4")],
				[
					RulesView.view(h, {
						model: model.rules,
						toParentMessage: (message) => Message.GotRulesMessage({ message }),
						idPrefix: "source",
						clock: null,
					}),
				],
			),
		],
	)

const nameCard = (h: H, model: Model, platform: SourcePlatform, created: Created | null): Html =>
	stepCard(
		h,
		{
			icon: "KeyIcon",
			title: created === null ? "Name the source" : "Source",
			note: isPublicSourcePlatform(platform) ? "Public token" : "Write-only token",
		},
		[
			note(
				h,
				isPublicSourcePlatform(platform)
					? "Your site sends data to Maple with this source's public token. It ships in your client code, which is safe: it can only write to this source, never read."
					: "Your app sends data to Maple with this source's token. It can only write to this source, never read.",
			),
			nameField(h, model, platform, created),
			...(created === null ? [advanced(h, model)] : []),
		],
	)

/** The one-time token, above the snippet it is already written into. */
const tokenField = (h: H, model: Model, platform: SourcePlatform, created: Created): Html =>
	vstack(h, { gap: "2" }, [
		copyableField(h, {
			id: "source-token",
			label: isPublicSourcePlatform(platform) ? "Public token" : "Token",
			value: created.secret,
			copyLabel: "Source token",
			copy: model.tokenCopy,
			toCopyMessage: (message) => Message.GotTokenCopyMessage({ message }),
		}),
		note(h, "Copy it now, it won't be shown again."),
	])

const sendCard = (h: H, model: Model, platform: SourcePlatform, created: Created | null): Html => {
	const typed = Str.trim(model.name)
	const name = created === null ? (typed === "" ? defaultSourceName(platform) : typed) : created.source.name
	return stepCard(
		h,
		{
			icon: "CodeIcon",
			title: `Send data from ${name}`,
		},
		[
			...(created === null ? [] : [tokenField(h, model, platform, created)]),
			Setup.view(h, {
				model: model.setup,
				toParentMessage: (message) => Message.GotSetupMessage({ message }),
				platform,
				name,
				token: created === null ? null : created.secret,
				keyPrefix: created === null ? null : created.source.key_prefix,
				idPrefix: "source-setup",
				isCompact: true,
			}),
			...(created === null ? [note(h, "Create the source to put its token in the snippet.")] : []),
		],
	)
}

/** One poll answers it: `last_used_at` is set by the first accepted request. */
const firstData = (h: H, receiving: boolean): Html =>
	statusRow(
		h,
		receiving
			? { tone: "ok", text: "Receiving data." }
			: {
					tone: "working",
					text: "Waiting for first data. Checked every 5 seconds.",
				},
	)

const createFooter = (h: H, model: Model): Html =>
	flowFooter(h, {
		back: Message.ClickedBack(),
		hint: "The token is shown once, right after you create the source.",
		actions: [
			button(
				h,
				{
					type: "submit",
					isDisabled: Str.trim(model.name).length === 0 || !rulesOutcome(model.rules).valid,
					isLoading: model.isSaving,
				},
				["Create source"],
			),
		],
	})

/** The drawer stays in onboarding: Done closes it where the page opens the source. */
const createdFooter = (h: H, created: Created, receiving: boolean, host: FlowHost): Html =>
	flowFooter(h, {
		back: null,
		hint: receiving
			? "Data is arriving. The source page shows what came in."
			: "Saved. The source keeps listening after you leave.",
		actions: [
			host === "drawer"
				? button(
						h,
						{
							variant: receiving ? "default" : "outline",
							attributes: [h.OnClick(Message.ClickedDone())],
						},
						["Done"],
					)
				: linkButton(
						h,
						{ variant: receiving ? "default" : "outline", href: sourceHref(created.source) },
						["Open source", icon(h, "ArrowRightIcon", { size: 14 })],
					),
		],
	})

/** `platform` is the picked one before Create and the created source's after it. */
export const pushStep = (
	h: H,
	model: Model,
	platform: SourcePlatform,
	created: Created | null,
	host: FlowHost,
): Html => {
	const receiving = isReceiving(model)
	const columns = flowColumns(
		h,
		[
			nameCard(h, model, platform, created),
			sendCard(h, model, platform, created),
			...(created === null ? [] : [firstData(h, receiving)]),
		],
		isPushSourcePlatform(platform) ? showsUpRail(h, platform) : null,
	)
	// A form only while there is something to submit: Enter in the read-only token must not create again.
	return created === null
		? h.form(
				[h.Class("flex w-full flex-1 flex-col gap-4"), h.OnSubmit(Message.SubmittedForm())],
				[columns, createFooter(h, model)],
			)
		: vstack(h, { gap: "4", grow: true, className: "w-full" }, [
				columns,
				createdFooter(h, created, receiving, host),
			])
}
