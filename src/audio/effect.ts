import * as Tone from 'tone';

export type VoiceEffect = Tone.Reverb;
const unit = (value: number) => Math.max(0, Math.min(1, value));
// A finite, damped response controls the shared reverb decay.
export function reverbWet(amount: number): number { return .32 * unit(amount) ** 1.6; }
export function reverbDecaySeconds(time: number): number { return .35 + 5.65 * unit(time) ** 1.7; }
export function createEffect(time: number, context?: Tone.Context): VoiceEffect {
  const effect = new Tone.Reverb({ decay: reverbDecaySeconds(time), preDelay: .018, ...(context ? { context } : {}) });
  effect.wet.value = 1;
  return effect;
}
