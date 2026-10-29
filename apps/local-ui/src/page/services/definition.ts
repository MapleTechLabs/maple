import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The services list page's Definition: its asks to the root are the shared PageOutMessage.

export const ServicesDefinition = Block.makeDefinition("Services", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
