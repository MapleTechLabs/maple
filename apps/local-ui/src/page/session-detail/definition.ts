import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The session detail page's Definition: its asks to the root are the shared PageOutMessage.

export const SessionDetailDefinition = Block.makeDefinition("SessionDetail", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
