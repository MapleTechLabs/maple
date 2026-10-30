import { Block } from "foldkit"
import { PageOutMessage } from "../contract"
import { Message } from "./message"
import { ChildInitContext, Model } from "./model"

// The Trace detail page's Definition: its asks to the root are the shared PageOutMessage.

export const TraceDetailDefinition = Block.makeDefinition("TraceDetail", {
	Model,
	Message,
	OutMessage: PageOutMessage,
	ChildInitContext,
})

export const { makeStep, makeNoopStep, makeFieldsStep, makeCommandsStep } = TraceDetailDefinition
