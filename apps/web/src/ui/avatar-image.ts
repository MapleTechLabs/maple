const AVATAR_IMAGE = 'img[data-slot="avatar-image"]'

const flagAvatarImage = (event: Event): void => {
	if (!(event.target instanceof HTMLImageElement) || !event.target.matches(AVATAR_IMAGE)) return
	if (event.type === "load") event.target.dataset.loaded = ""
	else delete event.target.dataset.loaded
}

/**
 * `AvatarImage` drops its `AvatarFallback` once loaded. Foldkit has no stateless load hook, so one
 * capture listener (load/error do not bubble) sets `data-loaded`, and styles.css hides the initials.
 */
export const trackAvatarImageLoads = (target: Document = document): void => {
	target.addEventListener("load", flagAvatarImage, true)
	target.addEventListener("error", flagAvatarImage, true)
}
