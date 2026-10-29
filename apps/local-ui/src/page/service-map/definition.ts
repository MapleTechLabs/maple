import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

// The service map page's Definition: its asks to the root are the shared PageOutMessage.

export const ServiceMapPageDefinition = Block.makeDefinition("ServiceMapPage", {
	Model,
	Message,
	OutMessage: PageOutMessage,
})
