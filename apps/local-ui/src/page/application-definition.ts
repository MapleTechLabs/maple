import { Block } from "foldkit"
import { Message } from "../message"
import { Model } from "../model"

// The root's Definition, which the page Bindings in registry.ts are made from. The root's
// Composition must come from this same value.

export const ApplicationDefinition = Block.makeDefinition("Application", { Model, Message })
