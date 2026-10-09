// The ARAN+ sting, played with the intro (intro.ts): ARAN+'s own take on a streaming
// service's opening sound, made here with Web Audio rather than recorded. The iPhone app's
// (web-iptv-player, src/ui/sting.ts), with one change for the TV: its room echo is two
// short delays fed back, not a convolution reverb, which took the TV's processor (making
// the impulse, then convolving it) just as the intro had to move smoothly. A soft low
// knock; then a big boom with a dreamy chord (D major 9) blooming out of it through an
// opening filter; two bell-like pings for the plus; and a rising whoosh as the intro
// flies into the app. About three seconds, with an echo tail.
//
// It works on any BaseAudioContext, so it can also be rendered offline (to listen to it
// as a file, or to test it).

// When each part happens, in seconds from the start; the intro's animation keeps time
// with these (intro.css uses the same numbers). The whoosh goes with the flight into
// the app, whenever that is (playWhoosh).
export const BEAT = { knock: 0.1, boom: 0.5, pings: [0.68, 0.82] };
export const STING_SECONDS = 3.4; // until the chord has died away (the reverb rings on)
const ECHOES: [number, number][] = [
  [0.113, 0.42],
  [0.187, 0.36],
];

// D3, A3, E4, F#4, C#5: open, warm and a little wistful.
const CHORD = [146.83, 220.0, 329.63, 369.99, 554.37];
const PINGS = [1760.0, 2637.02]; // A6, E7

export function playSting(ctx: BaseAudioContext, start = ctx.currentTime + 0.05): void {
  // Everything goes through a gentle limiter, so the boom never clips.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -10;
  limiter.knee.value = 8;
  limiter.ratio.value = 8;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;
  const master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(limiter);
  limiter.connect(ctx.destination);

  // The room: two delays, each fed back into itself, through a low-pass so the echoes
  // darken as they die away.
  const reverb = ctx.createGain();
  const wet = ctx.createGain();
  wet.gain.value = 0.3;
  const darken = ctx.createBiquadFilter();
  darken.type = "lowpass";
  darken.frequency.value = 3200;
  reverb.connect(darken);
  for (const [seconds, feedback] of ECHOES) {
    const delay = ctx.createDelay(1);
    delay.delayTime.value = seconds;
    const back = ctx.createGain();
    back.gain.value = feedback;
    darken.connect(delay);
    delay.connect(back);
    back.connect(delay);
    delay.connect(wet);
  }
  wet.connect(master);

  // A sound's way out: straight on, and some of it into the reverb.
  const bus = (send: number, pan = 0): AudioNode => {
    const input = ctx.createGain();
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    input.connect(panner);
    panner.connect(master);
    const toReverb = ctx.createGain();
    toReverb.gain.value = send;
    panner.connect(toReverb);
    toReverb.connect(reverb);
    return input;
  };

  // --- The knock: a soft, low thump with a little click on top.
  const knock = start + BEAT.knock;
  tone(ctx, "sine", knock, 0.4, bus(0.15), (f) => {
    f.setValueAtTime(150, knock);
    f.exponentialRampToValueAtTime(55, knock + 0.14);
  }, envelope(0.55, 0.004, 0.35));
  noise(ctx, knock, 0.06, bus(0.1), "bandpass", 1800, envelope(0.12, 0.002, 0.05));

  // --- The boom: a falling sub, a punch of noise, and the chord opening up.
  const boom = start + BEAT.boom;
  tone(ctx, "sine", boom, 2.3, bus(0.2), (f) => {
    f.setValueAtTime(120, boom);
    f.exponentialRampToValueAtTime(38, boom + 0.9);
  }, envelope(0.95, 0.006, 2.2));
  noise(ctx, boom, 0.3, bus(0.2), "lowpass", 900, envelope(0.35, 0.003, 0.25));
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.Q.value = 2;
  filter.frequency.setValueAtTime(350, boom);
  filter.frequency.exponentialRampToValueAtTime(3200, boom + 0.45);
  filter.frequency.exponentialRampToValueAtTime(900, boom + 2.4);
  filter.connect(bus(0.45));
  CHORD.forEach((freq, i) => {
    const pan = (i % 2 === 0 ? -1 : 1) * 0.12 * i;
    const out = ctx.createStereoPanner();
    out.pan.value = pan;
    out.connect(filter);
    // Two saws a hair apart in pitch: one warm, wide voice.
    for (const cents of [-8, 8]) {
      tone(ctx, "sawtooth", boom, 2.9, out, (f, detune) => {
        f.setValueAtTime(freq, boom);
        detune.setValueAtTime(cents, boom);
      }, envelope(0.07, 0.06, 2.8));
    }
  });
  // High air over the chord, mostly reverb.
  tone(ctx, "sine", boom + 0.05, 2.6, bus(0.8), (f) => f.setValueAtTime(1174.66, boom), envelope(0.03, 0.3, 2.4));

  // --- The plus: two bell-like pings, left then right.
  BEAT.pings.forEach((at, i) => {
    const t = start + at;
    const out = bus(0.6, i === 0 ? -0.35 : 0.35);
    tone(ctx, "sine", t, 1.0, out, (f) => f.setValueAtTime(PINGS[i], t), envelope(0.16, 0.002, 0.9));
    // A quieter, inharmonic partial makes it ring like metal.
    tone(ctx, "sine", t, 0.6, out, (f) => f.setValueAtTime(PINGS[i] * 2.76, t), envelope(0.04, 0.002, 0.5));
  });
}

// The whoosh: noise swept up as the intro flies into the app.
export function playWhoosh(ctx: BaseAudioContext, at = ctx.currentTime + 0.02): void {
  const out = ctx.createGain();
  out.gain.value = 0.85;
  out.connect(ctx.destination);
  const whoosh = at;
  const sweep = ctx.createBiquadFilter();
  sweep.type = "bandpass";
  sweep.Q.value = 0.8;
  sweep.frequency.setValueAtTime(300, whoosh);
  sweep.frequency.exponentialRampToValueAtTime(5000, whoosh + 0.7);
  sweep.connect(out);
  const air = ctx.createBufferSource();
  air.buffer = noiseBuffer(ctx, 0.8);
  const airGain = ctx.createGain();
  airGain.gain.setValueAtTime(0, whoosh);
  airGain.gain.linearRampToValueAtTime(0.2, whoosh + 0.5);
  airGain.gain.linearRampToValueAtTime(0, whoosh + 0.78);
  air.connect(airGain);
  airGain.connect(sweep);
  air.start(whoosh);
  air.stop(whoosh + 0.8);
}

// --- Building blocks ---------------------------------------------------------------------

type Envelope = (gain: AudioParam, at: number) => void;

// Up to `peak` in `attack` seconds, then dying away over `decay` seconds.
function envelope(peak: number, attack: number, decay: number): Envelope {
  return (gain, at) => {
    gain.setValueAtTime(0, at);
    gain.linearRampToValueAtTime(peak, at + attack);
    gain.exponentialRampToValueAtTime(0.0001, at + attack + decay);
  };
}

function tone(
  ctx: BaseAudioContext,
  type: OscillatorType,
  at: number,
  seconds: number,
  out: AudioNode,
  pitch: (frequency: AudioParam, detune: AudioParam) => void,
  shape: Envelope,
): void {
  const osc = ctx.createOscillator();
  osc.type = type;
  pitch(osc.frequency, osc.detune);
  const gain = ctx.createGain();
  shape(gain.gain, at);
  osc.connect(gain);
  gain.connect(out);
  osc.start(at);
  osc.stop(at + seconds + 0.05);
}

function noise(ctx: BaseAudioContext, at: number, seconds: number, out: AudioNode, type: BiquadFilterType, frequency: number, shape: Envelope): void {
  const source = ctx.createBufferSource();
  source.buffer = noiseBuffer(ctx, seconds);
  const filter = ctx.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  const gain = ctx.createGain();
  shape(gain.gain, at);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(out);
  source.start(at);
  source.stop(at + seconds);
}

function noiseBuffer(ctx: BaseAudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.max(1, Math.floor(ctx.sampleRate * seconds)), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

