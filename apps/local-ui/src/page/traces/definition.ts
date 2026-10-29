import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The traces list page's Definition: its asks to the root are the shared PageOutMessage.

export const TracesDefinition = Block.makeDefinition("Traces", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
