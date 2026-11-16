import { SECURITY_PR_CHECK_NAME } from "@maple/domain/http"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription, alertTitle } from "@maple/views/ui/alert"
import { copyableField } from "@maple/views/ui/copyable-field"
import { formDialog } from "@maple/views/ui/form-dialog"
import { icon } from "@maple/views/ui/icon"
import * as SelectView from "@maple/views/ui/select-view"
import { settingRow } from "@maple/views/ui/setting-row"
import * as Switch from "@maple/views/ui/switch"
import { textLink } from "@maple/views/ui/text-link"
import { typography } from "@maple/views/ui/typography"
import { vstack, vstackClass } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"
import { PR_CHECK_BLOCK_LABEL, repositoryRulesHref } from "./format"
import { BLOCK_CHOICES, DIALOG_ID, Message, type Model } from "./pr-check-settings"

// The pull request check form inside the shared FormDialog.

type H = HtmlBuilder<Message>

const SWITCH_ID = `${DIALOG_ID}-enabled`
const BLOCK_AT_LABEL_ID = `${DIALOG_ID}-block-at-label`
const BLOCK_AT_DESCRIPTION_ID = `${DIALOG_ID}-block-at-description`

const BLOCK_ENTRIES: ReadonlyArray<SelectView.SelectEntry> = Arr.map(BLOCK_CHOICES, (choice) => ({
	_tag: "Item",
	item: { value: choice, label: PR_CHECK_BLOCK_LABEL[choice] },
}))

const enabledRow = (h: H, model: Model, branch: string): Html =>
	settingRow(h, {
		ids: {
			control: `${SWITCH_ID}-input`,
			label: `${SWITCH_ID}-label`,
			description: `${SWITCH_ID}-description`,
		},
		label: `Check pull requests into ${branch}`,
		description:
			"Each push to a pull request runs a quick audit of the files it changes and reports the result on GitHub.",
		filled: model.enabled.isChecked,
		control: Switch.switchControl(h, {
			id: SWITCH_ID,
			inputId: `${SWITCH_ID}-input`,
			isChecked: model.enabled.isChecked,
			labelledBy: `${SWITCH_ID}-label`,
			describedBy: `${SWITCH_ID}-description`,
			isFilled: model.enabled.isChecked,
			onToggle: Message.GotEnabledMessage({ message: Switch.Message.ToggledSwitch() }),
		}),
	})

const blockAtField = (h: H, model: Model, branch: string): Html =>
	vstack(h, { gap: "1.5" }, [
		typography(h, { size: "sm", weight: "medium", attributes: [h.Id(BLOCK_AT_LABEL_ID)] }, [
			"Fail the check at",
		]),
		h.submodel({
			slotId: model.blockAt.id,
			model: model.blockAt,
			view: SelectView.view,
			viewInputs: {
				entries: BLOCK_ENTRIES,
				labelledBy: BLOCK_AT_LABEL_ID,
				describedBy: BLOCK_AT_DESCRIPTION_ID,
				className: "w-full max-w-64",
				toView: (parts) => h.div([h.Class("contents")], parts),
			},
			toParentMessage: (message) => Message.GotBlockAtMessage({ message }),
		}),
		typography(h, { size: "xs", tone: "muted", as: "p", attributes: [h.Id(BLOCK_AT_DESCRIPTION_ID)] }, [
			`Only confirmed findings the pull request brings count. Dismissed or accepted findings and ones ${branch} already has never fail it. If the audit cannot run, the check reports neutral.`,
		]),
	])

const requiredSection = (h: H, model: Model, repository: string, branch: string): Html =>
	vstack(h, { gap: "3", className: "border-t pt-5" }, [
		vstack(h, { gap: "1" }, [
			typography(h, { size: "sm", weight: "medium" }, ["Make it required"]),
			typography(h, { size: "xs", tone: "muted", as: "p" }, [
				`The check reports on every pull request, but it only blocks a merge once a branch rule requires it. In GitHub, add a rule for ${branch} that requires status checks to pass, and pick this check.`,
			]),
		]),
		copyableField(h, {
			id: `${DIALOG_ID}-check-name`,
			value: SECURITY_PR_CHECK_NAME,
			copyLabel: "Check name",
			copy: model.copy,
			toCopyMessage: (message) => Message.GotCopyMessage({ message }),
		}),
		typography(h, { size: "xs", className: "self-start" }, [
			textLink(
				h,
				{
					href: repositoryRulesHref(repository),
					tone: "muted",
					attributes: [h.Target("_blank"), h.Rel("noopener noreferrer")],
				},
				["Open repository rules on GitHub", icon(h, "ExternalLinkIcon", { size: 12 })],
			),
		]),
	])

const failureAlert = (h: H, model: Model): ReadonlyArray<Html> =>
	model.failure === null
		? []
		: [
				alert(h, { variant: "crit" }, [
					icon(h, "CircleWarningIcon"),
					alertTitle(h, [model.failure.title]),
					alertDescription(h, [model.failure.message]),
				]),
			]

const prCheckDialog = (h: H, model: Model): Html => {
	const repository = model.target?.repository ?? ""
	const branch = model.target?.branch ?? "the branch"
	return formDialog(h, {
		slotId: DIALOG_ID,
		model: model.dialog,
		toParentMessage: (message) => Message.GotDialogMessage({ message }),
		title: "Pull request check",
		description: repository,
		onSubmit: Message.Submitted(),
		submitLabel: "Save changes",
		isPending: model.isPending,
		panelClassName: vstackClass({ gap: "5" }),
		fields: [
			...failureAlert(h, model),
			enabledRow(h, model, branch),
			...(model.enabled.isChecked
				? [blockAtField(h, model, branch), requiredSection(h, model, repository, branch)]
				: []),
		],
	})
}

export const prCheckSettingsView = Submodel.defineView<Model, Message, Readonly<Record<never, never>>>(
	(model, _inputs, h) => prCheckDialog(h, model),
)
