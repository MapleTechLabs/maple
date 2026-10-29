import { Update } from "foldkit"
import { initAndSet } from "foldkit/bindingInit"
import { modifyFields } from "foldkit/struct"
import { updateCopy } from "../copies"
import {
	AttributesBinding,
	DialogBinding,
	LogSheetComposition,
	TabsBinding,
	TooltipBinding,
} from "./composition"
import { makeFieldsStep, makeNoopStep, makeStep } from "./definition"
import { Message } from "./message"
import { ATTRIBUTES_ID, type LocalLog, logKey, type Model, tabValuesOf } from "./model"

export const isOpen = (model: Model): boolean => model.dialog.isOpen

/** A first row click: the sheet starts on `log`, already opening. The children start from the Bindings. */
export const init = LogSheetComposition.makeInit((log: LocalLog) => ({
	childInitContext: { log },
	model: { log, isBodyExpanded: false, isErrorExpanded: false, copies: {} },
	steps: [DialogBinding.requestOpen()],
}))

const isSameValues = (a: ReadonlyArray<string>, b: ReadonlyArray<string>): boolean =>
	a.length === b.length && a.every((value, index) => value === b[index])

export const update = LogSheetComposition.makeUpdate({
	ClosedSheet: (model) => DialogBinding.requestClose()(model),
	ToggledBodyExpanded: (model) => ({
		model: modifyFields(model, { isBodyExpanded: (isExpanded) => !isExpanded }),
	}),
	ToggledErrorExpanded: (model) => ({
		model: modifyFields(model, { isErrorExpanded: (isExpanded) => !isExpanded }),
	}),
	ReceivedCopyMessage: (model, { message }) => {
		const next = updateCopy(model.copies, message, (copy) =>
			Message.ReceivedCopyMessage({ message: copy }),
		)
		return { model: modifyFields(model, { copies: () => next.copies }), commands: next.commands }
	},
	// A sheet that stays mounted keeps its tab and body expansion; the rest is per log. The tooltip
	// starts closed: one left open when the sheet closed would show on a button nobody hovered.
	RequestedShowLog: (model, { log }) => {
		const isSameLog = logKey(model.log) === logKey(log)
		const values = tabValuesOf(log)
		return Update.combineSteps(model, [
			makeFieldsStep(() => ({
				log: () => log,
				isErrorExpanded: (isExpanded: boolean) => isSameLog && isExpanded,
			})),
			// The Trace tab comes and goes with the trace id; the selected tab stays.
			isSameValues(model.tabs.values, values)
				? makeNoopStep()
				: makeStep((current: Model) =>
						initAndSet(TabsBinding, current, {
							args: [{ idBase: current.tabs.idBase, values, selected: current.tabs.selected }],
						}),
					),
			isSameLog
				? makeNoopStep()
				: makeStep((current: Model) =>
						initAndSet(AttributesBinding, current, { args: [ATTRIBUTES_ID] }),
					),
			TooltipBinding.requestReset(),
			DialogBinding.requestOpen(),
		])
	},
})
