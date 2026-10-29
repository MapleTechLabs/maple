import { Block } from "foldkit"
import { Message, Model, OutMessage } from "./model"

// The Waterfall tab's Definition: its Mount and Composition author against it.

export const WaterfallDefinition = Block.makeDefinition("Waterfall", { Model, Message, OutMessage })
