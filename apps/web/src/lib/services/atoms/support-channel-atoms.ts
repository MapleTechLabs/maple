import { MapleApiV2AtomClient, retainedQueryV2 } from "@/lib/services/common/v2-atom-client"

/**
 * The org's shared Slack channel. Built per render so the retained entry is keyed on the active
 * org; read only while the support dialog is open, so the sidebar never fetches it on its own.
 */
export const supportChannelAtom = () => retainedQueryV2("supportChannel", "retrieve", {})

export const inviteToSupportChannelMutation = MapleApiV2AtomClient.mutation("supportChannel", "invite")
