import { Schema } from "effect"

/** How the map is drawn: the inked 3D scene, or pixel art drawn from sprites. */
export const ArtStyle = Schema.Literals(["painted", "pixel"])
export type ArtStyle = typeof ArtStyle.Type
