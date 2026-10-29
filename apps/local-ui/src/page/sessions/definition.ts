import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The sessions page's Definition: its asks to the root are the shared PageOutMessage.

export const SessionsDefinition = Block.makeDefinition("Sessions", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
