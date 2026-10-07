// The "blop" played when a session finishes a turn: a short sine that slides up an octave and fades,
// like a drop of water. Synthesised, so there is no sound file to ship.

export function playBlop(volume = 0.22): void {
  const ctx = new AudioContext()
  const t = ctx.currentTime + 0.01
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.type = 'sine'
  osc.frequency.setValueAtTime(520, t)
  osc.frequency.exponentialRampToValueAtTime(1040, t + 0.07)
  gain.gain.setValueAtTime(0.0001, t)
  gain.gain.exponentialRampToValueAtTime(volume, t + 0.012)
  gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22)
  osc.connect(gain).connect(ctx.destination)
  osc.start(t)
  osc.stop(t + 0.25)
  osc.onended = () => void ctx.close()
}
