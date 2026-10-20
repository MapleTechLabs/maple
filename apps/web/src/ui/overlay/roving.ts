import { Array, Option } from "effect"

/**
 * Base UI's list navigation for menus and listboxes: arrows move the highlight and wrap
 * (`loop`), Home/End jump, disabled entries are skipped.
 */
export type RovingKey = "ArrowDown" | "ArrowUp" | "Home" | "End"

export const isRovingKey = (key: string): key is RovingKey =>
	key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End"

export const nextIndex = (
	enabled: ReadonlyArray<boolean>,
	current: number | null,
	key: RovingKey,
): Option.Option<number> => {
	const indices = Array.getSomes(
		enabled.map((isEnabled, index) => (isEnabled ? Option.some(index) : Option.none())),
	)
	const position = current === null ? -1 : indices.indexOf(current)
	switch (key) {
		case "Home":
			return Array.head(indices)
		case "End":
			return Array.last(indices)
		case "ArrowDown":
			return Array.get(indices, position === -1 || position === indices.length - 1 ? 0 : position + 1)
		case "ArrowUp":
			return Array.get(indices, position <= 0 ? indices.length - 1 : position - 1)
	}
}
