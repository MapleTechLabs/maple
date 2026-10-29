import { Block } from "foldkit"
import { Message, OutMessage } from "./message"
import { Model } from "./model"

// The Timeline tab's Definition: its Commands, Mounts, Bindings and Composition author against it.

export const TimelineDefinition = Block.makeDefinition("Timeline", { Model, Message, OutMessage })
