import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The Metric detail page's Definition: its asks to the root are the shared PageOutMessage.

export const MetricDetailDefinition = Block.makeDefinition("MetricDetail", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
