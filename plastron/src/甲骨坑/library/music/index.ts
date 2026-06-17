import type { 甲骨, Cel, Fn, State } from "../../../types/index.js";
import { bindNativeFns, resolveFn } from "../../../kernel/index.js";
import seed from "./甲骨.json" with { type: "json" };

// ============================================================================
// music — a MIDI-shaped vocabulary over the sound segment's Web Audio synth.
//
// MIDI rows carry { track, channel, pitch, notename, start, dur, velocity }.
// This segment turns that into sound:
//   • notename("C4")        → MIDI number (69 = A4 = 440Hz)
//   • note(pitch,start,dur,velocity[,channel]) → a pure NOTE SPEC
//   • miditrack(range[,bpm])→ a ▶ player vnode bound to the music.play handler
//   • music.play (handler)  → schedules every note on the AUDIO CLOCK (sample-
//                             accurate via sound.play-tone's `when` offset)
//
// Why a player + handler rather than "=note() makes a sound": a formula is
// evaluated during COMPUTE and must stay pure; making sound is an EFFECT, so it
// lives behind a dispatch (the inputMap/effect doctrine). `note` builds the
// spec, `miditrack` builds the UI, the handler does the IO on click.
// ============================================================================

const SEMIS: Record<string, number> = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
// "C4" → 60, "A4" → 69, "F#3"/"Gb3" supported. MIDI = (octave+1)*12 + semitone.
const noteToMidi = (raw: unknown): number | null => {
  const m = /^([A-Ga-g])([#b]?)(-?\d+)$/.exec(String(raw ?? "").trim());
  if (!m) return null;
  let s = SEMIS[m[1]!.toLowerCase()]!;
  if (m[2] === "#") s += 1; else if (m[2] === "b") s -= 1;
  return s + (Number(m[3]) + 1) * 12;
};
const midiToFreq = (p: number): number => 440 * Math.pow(2, (p - 69) / 12);
const num = (v: unknown, d = 0): number => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const WAVE: Array<"sine" | "triangle" | "square" | "sawtooth"> = ["sine", "triangle", "square", "sawtooth"];

interface NoteSpec { note: true; pitch: number; start: number; dur: number; vel: number; chan: number }
const isNote = (v: unknown): v is NoteSpec => !!v && typeof v === "object" && (v as NoteSpec).note === true;

// notename — "C4" → MIDI integer. A bare number passes through (already MIDI).
const notename: Fn = (name: unknown): number => {
  if (typeof name === "number") return name;
  return noteToMidi(name) ?? 0;
};

// note(pitch, start, dur, velocity[, channel]) — a pure note spec. `pitch` is a
// MIDI number or a notename string; start/dur in BEATS; velocity 0–127.
const note: Fn = (pitch: unknown, start: unknown, dur: unknown, velocity: unknown, channel?: unknown): NoteSpec => ({
  note: true,
  pitch: typeof pitch === "string" ? (noteToMidi(pitch) ?? 0) : num(pitch, 60),
  start: num(start, 0), dur: num(dur, 1), vel: num(velocity, 90), chan: num(channel, 0),
});

// Coerce a value into note specs: a range arrives as nested rows (f parser) or a
// flat member array (infix). Each note-row is [track, channel, pitch, notename,
// start, dur, velocity]; pitch falls back to notename. Bare note() specs and
// arrays of them pass through.
const toNotes = (v: unknown): NoteSpec[] => {
  if (isNote(v)) return [v];
  if (!Array.isArray(v)) return [];
  if (v.every((r) => Array.isArray(r))) {
    return (v as unknown[][]).map((r) => {
      const pitch = (r[2] === "" || r[2] == null) ? (noteToMidi(r[3]) ?? 0) : num(r[2], 60);
      return { note: true as const, pitch, start: num(r[4], 0), dur: num(r[5], 1), vel: num(r[6], 90), chan: num(r[1], 0) };
    }).filter((n) => n.pitch > 0);
  }
  // flat: either an array of note() specs, or 7-wide chunks
  if (v.some(isNote)) return v.filter(isNote);
  const out: NoteSpec[] = [];
  for (let i = 0; i + 6 < v.length; i += 7) {
    const pitch = (v[i + 2] === "" || v[i + 2] == null) ? (noteToMidi(v[i + 3]) ?? 0) : num(v[i + 2], 60);
    if (pitch > 0) out.push({ note: true, pitch, start: num(v[i + 4], 0), dur: num(v[i + 5], 1), vel: num(v[i + 6], 90), chan: num(v[i + 1], 0) });
  }
  return out;
};

// miditrack(range[, bpm]) — a ▶ player vnode. Clicking dispatches music.play
// with the resolved notes; the handler schedules them. Pure (builds a vnode).
const miditrack: Fn = (range: unknown, bpm?: unknown): unknown => {
  const notes = toNotes(range);
  const tempo = num(bpm, 120);
  const beats = notes.reduce((m, n) => Math.max(m, n.start + n.dur), 0);
  const label = `▶ play  ·  ${notes.length} notes  ·  ${tempo} bpm`;
  return {
    type: "el", tag: "div", attrs: { class: "pl-miditrack" },
    style: { display: "inline-flex", "flex-direction": "column", gap: ".4rem", padding: ".5rem .7rem", border: "1px solid #8884", "border-radius": ".5rem", background: "#16161f", color: "#c9c9d4", font: "600 .8rem ui-monospace,monospace" },
    children: [
      { type: "el", tag: "button",
        attrs: { class: "pl-miditrack-play" },
        style: { cursor: "pointer", padding: ".35rem .8rem", border: "1px solid #7fd0ff", "border-radius": ".4rem", background: "#7fd0ff22", color: "#7fd0ff", font: "inherit" },
        events: { click: { dispatch: "music.play", payload: { notes, bpm: tempo } } },
        children: [{ type: "text", text: label }] },
      { type: "el", tag: "div", style: { color: "#8a8a99", "font-size": ".72rem" },
        children: [{ type: "text", text: `${beats} beats · channels render as sine/triangle/square/saw` }] },
    ],
  };
};

// music.play — the EFFECT. Schedules each note on the Web Audio clock at its
// start beat (sample-accurate via sound.play-tone's `when`). bpm → seconds/beat.
const play: Fn = (state: State, payload?: unknown) => {
  const p = (payload ?? {}) as { notes?: unknown; bpm?: unknown };
  const notes = toNotes(Array.isArray(p.notes) ? p.notes : []);
  const spb = 60 / Math.max(1, num(p.bpm, 120));
  const playTone = resolveFn(state, "sound.play-tone") as Fn | undefined;
  if (!playTone) return state;
  for (const n of notes) {
    playTone(state, {
      freq: midiToFreq(n.pitch), duration: Math.max(0.05, n.dur * spb) * 1000,
      gain: Math.min(0.5, (n.vel / 127) * 0.35), type: WAVE[((n.chan % 4) + 4) % 4], when: n.start * spb,
    });
  }
  return state;
};

export const name = "music" as const;

export const cels: Cel[] = bindNativeFns(seed as unknown as 甲骨, new Map<string, Fn>([
  ["notename", notename],
  ["note", note],
  ["miditrack", miditrack],
  ["music.play", play],
]));
