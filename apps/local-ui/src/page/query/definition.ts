import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The Query page's Definition: its asks to the root are the shared PageOutMessage.

export const QueryDefinition = Block.makeDefinition("Query", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
