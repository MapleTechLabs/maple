import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The Metrics page's Definition: its asks to the root are the shared PageOutMessage.

export const MetricsDefinition = Block.makeDefinition("Metrics", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
