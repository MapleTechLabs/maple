import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"

/**
 * `/share/$token`: a public page outside the shell. The root renders it bare and gives it a
 * context without a signed-in org (see `pageContextOf`); one instance per token.
 */
export const entry = definePage(
	"Share",
	{ Model, Message },
	{ routes: ["Share"], key: (route) => route.token },
)

export const page = entry.lazy(() => import("./implementation"))
