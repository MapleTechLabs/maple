// The list peeks' step keys: down/J forward, up/K back, except in a text field or with a modifier.

export type PeekStep = 1 | -1

export const peekStepFor = (event: KeyboardEvent): PeekStep | undefined => {
	if (event.metaKey || event.ctrlKey || event.altKey || isTextEntry(event.target)) return undefined
	switch (event.key) {
		case "ArrowDown":
		case "j":
		case "J":
			return 1
		case "ArrowUp":
		case "k":
		case "K":
			return -1
		default:
			return undefined
	}
}

const isTextEntry = (target: EventTarget | null): boolean =>
	target instanceof HTMLElement &&
	(target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		target.isContentEditable)
