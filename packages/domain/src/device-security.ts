import { Schema } from "effect"

// Findings from the org's device management tools. Each source (Fleet first) syncs on its own and
// writes the same shapes, so the Security hub's Devices page reads every source as one list.

export const DEVICE_SOURCE_KINDS = ["fleet"] as const
export const DeviceSourceKind = Schema.Literals(DEVICE_SOURCE_KINDS)
export type DeviceSourceKind = typeof DeviceSourceKind.Type

/** A device a finding names, with its page in the source. A sample, not every device. */
export const DeviceRef = Schema.Struct({
	/** The source's own id: a number in Fleet, a GUID elsewhere. */
	id: Schema.String,
	name: Schema.String,
	platform: Schema.NullOr(Schema.String),
	url: Schema.String,
})
export type DeviceRef = typeof DeviceRef.Type

/** A software version that carries a CVE, and how many devices have it installed. */
export const VulnerableSoftware = Schema.Struct({
	name: Schema.String,
	version: Schema.String,
	/** How it was installed, as the source names it (`apps`, `deb_packages`, ...). */
	packageSource: Schema.NullOr(Schema.String),
	deviceCount: Schema.Number,
	resolvedInVersion: Schema.NullOr(Schema.String),
})
export type VulnerableSoftware = typeof VulnerableSoftware.Type
