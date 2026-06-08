---
name: sound
description: Web Audio capability segment. play-tone / play-pcm / stop-all plus master-gain and context-state. Browser-only; off-browser every fn is a silent no-op.
---

## Cels provided

- `sound.play-tone` (oscillator) / `sound.play-pcm` (Float32 samples) / `sound.stop-all` / `sound.stop-source` / `sound.update-source` / `sound.is-playing`.
- `sound.master-gain` / `sound.context-state` — control/descriptor cels.

## Usage

`resolveFn(state, "sound.play-tone")(...)`. Lazy AudioContext creation on first play (browser
autoplay policy). Module-scoped runtime state (context + active source set) is shared across
States. `_resetSoundForTests` exported for tests.
