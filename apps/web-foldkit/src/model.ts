import { OrgId } from "@maple/domain"
import { Schema } from "effect"
import { defineTaggedUnion } from "foldkit/schema"
import * as Home from "./page/home"
import * as SignIn from "./page/sign-in"
import { AppRoute } from "./route"

/** The router's `auth` context in apps/web: unknown until resolved (`<BootSplash>`), then settled. */
export const Session = defineTaggedUnion({
	Resolving: {},
	SignedOut: {},
	SignedIn: { maybeOrgId: Schema.Option(OrgId) },
})
export type Session = typeof Session.Type

/** clerk-js on `window.Clerk`, in Clerk mode only. */
export const ClerkPhase = defineTaggedUnion({
	Unused: {},
	Loading: {},
	Loaded: {},
	Failed: { message: Schema.String },
})
export type ClerkPhase = typeof ClerkPhase.Type

export const Model = Schema.Struct({
	route: AppRoute,
	session: Session,
	clerk: ClerkPhase,
	signIn: SignIn.Model,
	home: Home.Model,
})
export type Model = typeof Model.Type
