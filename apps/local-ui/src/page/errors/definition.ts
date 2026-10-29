import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The Errors page's Definition: its asks to the root are the shared PageOutMessage.

export const ErrorsDefinition = Block.makeDefinition("Errors", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
