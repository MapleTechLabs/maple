import { AnimationBlock, type InitConfig } from "@foldkit/ui/animation"
import { Option } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"

/**
 * A popup's enter/exit transition: Foldkit's Animation that also waits for the popup's exit
 * transition to settle once the leave starts, so parents only request show and hide.
 */
const Model = AnimationBlock.Model
type Model = typeof Model.Type

const Message = defineMessageUnion({
	RequestedShow: {},
	RequestedHide: {},
})
type Message = typeof Message.Type

const PopupTransitionDefinition = Block.makeDefinition("PopupTransition", { Model, Message })

// The Animation shares this Block's whole Model, so the accessors are the identity.
const AnimationBinding = PopupTransitionDefinition.makeBinding(AnimationBlock, {
	read: (model: Model) => Option.some(model),
	write: (_model: Model, animation: Model) => animation,
})

const AnimationBindingWithOutMessagePolicy = AnimationBinding.withOutMessagePolicy({
	fold: PopupTransitionDefinition.makeOutMessageFold(AnimationBlock, {
		StartedLeaveAnimating: () => AnimationBinding.requestWaitForLeaveSettlement(),
		TransitionedOut: PopupTransitionDefinition.makeNoopStep,
	}),
})

const PopupTransitionComposition = PopupTransitionDefinition.makeComposition({
	bindings: [AnimationBindingWithOutMessagePolicy],
})

const init = PopupTransitionComposition.makeInit((config: InitConfig) => ({
	model: AnimationBlock.init(config).model,
}))

const update = PopupTransitionComposition.makeUpdate({
	RequestedShow: (model) => AnimationBinding.requestShow()(model),
	RequestedHide: (model) => AnimationBinding.requestHide()(model),
})

const prepare = () =>
	PopupTransitionComposition.prepareBlock({
		init,
		update,
		operations: {
			requestShow: Message.RequestedShow,
			requestHide: Message.RequestedHide,
		},
	})
export const PopupTransitionBlock: Block.FromAssemblyWithoutViewOrOutMessage<typeof Model, typeof prepare> =
	Block.assemble(prepare)
