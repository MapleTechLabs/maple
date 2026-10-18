import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import { Option } from "effect"
import { Command } from "foldkit"
import { Message } from "./message"
import type { Detail, Model } from "./model"
import type { UpdateReturn } from "./update"

// The detail sheet's own steps: its tabs and its attributes panel, folded by the page.

const withDetail = (model: Model, write: (detail: Detail) => Detail): Model => ({
	...model,
	maybeDetail: Option.map(model.maybeDetail, write),
})

export const foldTabs = (model: Model, message: Tabs.Message): UpdateReturn =>
	Option.match(model.maybeDetail, {
		onNone: () => ({ model }),
		onSome: (detail) => {
			const next = Tabs.update(detail.tabs, message)
			return {
				model: withDetail(model, (current) => ({ ...current, tabs: next.model })),
				commands: Command.mapMessages(next.commands ?? [], (tabs) => Message.GotDetailTabsMessage({ message: tabs })),
			}
		},
	})

/** The local sheet has no attribute filters, so the panel's filter OutMessage is never raised. */
export const foldAttributes = (model: Model, message: AttributesPanel.Message): UpdateReturn =>
	Option.match(model.maybeDetail, {
		onNone: () => ({ model }),
		onSome: (detail) => {
			const next = AttributesPanel.update(detail.attributes, message)
			return {
				model: withDetail(model, (current) => ({ ...current, attributes: next.model })),
				commands: Command.mapMessages(next.commands ?? [], (panel) =>
					Message.GotDetailAttributesMessage({ message: panel }),
				),
			}
		},
	})

export const closeDetail = (model: Model): UpdateReturn => ({
	model: withDetail(model, (detail) => ({ ...detail, isOpen: false })),
})

export const toggleBody = (model: Model): UpdateReturn => ({
	model: withDetail(model, (detail) => ({ ...detail, isBodyExpanded: !detail.isBodyExpanded })),
})
