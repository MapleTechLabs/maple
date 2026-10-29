import { Record } from "effect"
import { Block } from "foldkit"
import { modifyFields } from "foldkit/struct"
import type { CopyStatus } from "../copy-button"
import {
	AttributesPanelComposition,
	EffectsLayer,
	isOpen,
	Model,
	OutMessage,
	WaitAttributeCopyStatus,
	WriteAttributeClipboard,
} from "./attributes-panel"
import { view } from "./attributes-view"

// The log attributes panel as a completed Block. Its init takes the panel's DOM id prefix.

const init = AttributesPanelComposition.makeInit((id: string) => ({
	model: Model.make({ id, search: "", open: {}, copy: { id: "", status: "idle", generation: 0 } }),
}))

const settled = (model: Model, generation: number, status: CopyStatus) =>
	generation === model.copy.generation
		? {
				model: modifyFields(model, { copy: (copy) => ({ ...copy, status }) }),
				commands: [WaitAttributeCopyStatus({ generation })],
			}
		: { model, commands: [] }

const update = AttributesPanelComposition.makeUpdate({
	ChangedSearch: (model, { text }) => ({ model: modifyFields(model, { search: () => text }) }),
	ToggledCollapsible: (model, { key, defaultOpen }) => ({
		model: modifyFields(model, {
			open: (open) => Record.set(open, key, !isOpen(model, key, defaultOpen)),
		}),
	}),
	ClickedCopy: (model, { copyId, text }) => {
		const generation = model.copy.generation + 1
		return {
			model: modifyFields(model, {
				copy: () => ({ id: copyId, status: "idle", generation }),
			}),
			commands: [WriteAttributeClipboard({ text, generation })],
		}
	},
	SucceededCopy: (model, { generation }) => settled(model, generation, "copied"),
	FailedCopy: (model, { generation }) => settled(model, generation, "error"),
	ElapsedCopyStatus: (model, { generation }) =>
		generation === model.copy.generation
			? { model: modifyFields(model, { copy: (copy) => ({ ...copy, status: "idle" }) }) }
			: { model },
	ClickedFilter: (model, { source, key, value, negated }) => ({
		model,
		outMessage: OutMessage.ChoseAttributeFilter({ source, key, value, negated }),
	}),
})

const prepare = () => AttributesPanelComposition.prepareBlock({ init, update, view, EffectsLayer })
export const AttributesPanelBlock: Block.FromAssemblyWithViewAndOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
