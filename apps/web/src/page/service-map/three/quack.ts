// A mallard's "wak-wak", synthesized: a low buzz, overdriven, through two vocal formants that
// open and close (the "wah"). No audio file; the context opens on the first click, inside the gesture.

export interface Quacker {
	/** `times` "wak"s in a row: two for a poke, more when the duck takes fright. */
	readonly quack: (times: number) => void
	readonly close: () => void
}

/** Opened on the first quack, closed with the scene. */
interface Voicebox {
	audio: AudioContext | null
}

const LENGTH = 0.17

// Soft clipping turns the buzz harsh and nasal.
const GRIT = Float32Array.from({ length: 1024 }, (_, i) => Math.tanh(((i / 1023) * 2 - 1) * 5))

/** One "wak" at `at` seconds on `audio`'s clock, buzzing at `pitch` Hz. */
export function wak(audio: BaseAudioContext, at: number, pitch: number) {
	const end = at + LENGTH
	const buzz = audio.createOscillator()
	buzz.type = "sawtooth"
	buzz.frequency.setValueAtTime(pitch * 0.85, at)
	buzz.frequency.linearRampToValueAtTime(pitch, at + 0.03)
	buzz.frequency.exponentialRampToValueAtTime(pitch * 0.7, end)
	const grit = audio.createWaveShaper()
	grit.curve = GRIT
	// The mouth: two formants swing open on the "w", then close on the "k".
	const formant = (from: number, open: number, close: number, q: number, gain: number) => {
		const band = audio.createBiquadFilter()
		band.type = "bandpass"
		band.Q.value = q
		band.frequency.setValueAtTime(from, at)
		band.frequency.exponentialRampToValueAtTime(open, at + 0.05)
		band.frequency.exponentialRampToValueAtTime(close, end)
		const level = audio.createGain()
		level.gain.value = gain
		grit.connect(band).connect(level)
		return level
	}
	const envelope = audio.createGain()
	envelope.gain.setValueAtTime(0.0001, at)
	envelope.gain.exponentialRampToValueAtTime(1, at + 0.012)
	envelope.gain.setValueAtTime(1, at + 0.09)
	envelope.gain.exponentialRampToValueAtTime(0.0001, end)
	formant(500, 1100, 650, 5, 1).connect(envelope)
	formant(1400, 2300, 1600, 7, 0.6).connect(envelope)
	envelope.connect(audio.destination)
	buzz.connect(grit)
	buzz.start(at)
	buzz.stop(end + 0.02)
}

export function quacker(): Quacker {
	const state: Voicebox = { audio: null }
	const quack = (times: number) => {
		const audio = state.audio ?? new AudioContext()
		state.audio = audio
		const now = audio.currentTime
		const pitch = 210 + Math.random() * 40
		Array.from({ length: times }, (_, i) => wak(audio, now + i * 0.2, pitch * 0.93 ** i))
	}
	return {
		quack,
		close: () => {
			void state.audio?.close()
			state.audio = null
		},
	}
}
