# Voice co-producer: a three-minute demo

Start with a supplied melody, ask for one precise edit at a time, and verify the
score before the next request. This is a **rehearsal plan, not a guarantee**:
network access, microphone permissions, model availability, and generated ABC
can still fail. The seeds below are original, simple examples, not model
outputs.

## Before the audience arrives

1. From `composing.studio/`, follow
   [the setup instructions](../README.md#getting-started) if dependencies or the
   WebAssembly package are missing. Configure `OPENAI_API_KEY` **only in the
   Rust server environment**, using your existing secret-management setup. Never
   paste a key into the editor or browser console.
2. Run `cargo run` in one terminal and `npm run dev` in another. Open the local
   URL printed by Vite. Its `/api` proxy expects the Rust server on port
   **3030**; keep `PORT` unset or set to `3030` for this setup.
3. Open a dedicated demo room. Paste **Seed A** into the ABC editor and wait for
   the notation to render. Do not use the random sample loader during rehearsal.
4. Use headphones, allow browser/OS microphone access, and click **Start voice**
   in the floating dock. Wait for **Listening** before speaking. Use localhost
   or HTTPS.
5. Run the sequence below once with the actual microphone and network. Load and
   play the seed beforehand to warm the music player. Stop voice and paste Seed
   A again before presenting. Live rehearsal uses the configured OpenAI account.

## Present the happy path

Say: “We added a voice co-producer to a collaborative music editor. The dock
shows what it is doing; the actual score is the source of truth.”

| Step | Exact voice prompt or action                                                                                                        | Verify before continuing                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 1    | Click **Start voice** with Seed A already loaded.                                                                                   | Connection completes; the dock is ready for input.                                  |
| 2    | “Change only the tempo of the current score to 108 quarter notes per minute. Keep every note, rhythm, and the key unchanged.”       | ABC contains `Q:1/4=108`; all four bars still match Seed A.                         |
| 3    | Click **Mute microphone**, then click the score's play button. Stop playback and click **Unmute microphone** before speaking again. | The faster version plays. Microphone mute is visible and does not end the session.  |
| 4    | “Move the entire current melody down exactly one octave. Keep the tempo at 108, the key in C major, and all rhythms unchanged.”     | First bar becomes `C,2 E,2 G,2 E,2`; every note is lowered, not just the key label. |
| 5    | Mute and play the score again, then click **End voice**.                                                                            | Lower melody is audible; the dock returns to **Offline**.                           |

Pause after each request: **Thinking**, **Updating score**, and **Responding**
are different activities. **Microphone muted** means only the microphone is
muted; voice replies and music playback are not muted. A spoken “done” is not
proof of an edit. Check the ABC, rendered notes, and playback; do not promise a
fixed response time. The score player is separate from voice: ask for edits by
voice, but click playback yourself.

**Optional collaboration moment:** open the same room URL in a second tab,
without starting a second voice session. Show the edited score arriving there.
Skip this if the collaborative connection is not healthy.

## Pasteable melodies

Replace the **entire** editor document with one block. Start with Seed A; Seed B
is a separate rehearsal, not an extra step in the short demo. Pasting the score
supplies it as context to the connected agent; it does not train the model or
install a guaranteed response. After a live paste, pause briefly before speaking
(score context updates are debounced by 400 ms).

### Seed A — C-major stepping stones

```abc
X:1
T:Demo - Stepping Stones
M:4/4
L:1/8
Q:1/4=84
K:C
C2 E2 G2 E2 | D2 F2 A2 F2 | E2 G2 A2 G2 | F2 D2 C4 |]
```

After the two successful edits, the headers stay unchanged except for
`Q:1/4=108`, and the music line should read:

```abc
C,2 E,2 G,2 E,2 | D,2 F,2 A,2 F,2 | E,2 G,2 A,2 G,2 | F,2 D,2 C,4 |]
```

### Seed B — A-minor evening walk

```abc
X:1
T:Demo - Evening Walk
M:4/4
L:1/8
Q:1/4=84
K:Am
A2 E2 C2 E2 | F2 E2 D4 | E2 G2 A2 G2 | E2 C2 A,4 |]
```

Rehearsal prompt: “Change only the tempo of the current score to 96 quarter
notes per minute. Keep the A-minor key and every note and rhythm unchanged.”
Verify `Q:1/4=96` and an otherwise unchanged document.

## Recovery: one retry, then the prepared fallback

- **Permission or connection error:** stop/cancel the session if still active,
  fix the microphone permission or server/network issue, then click **Retry
  voice** (or **Start voice** when offline) once. A missing-server-key error
  needs server configuration, not another voice prompt.
- **Thinking without progress or an incorrect edit:** stop voice before
  resetting so a late tool call cannot overwrite the reset. Save anything you
  need, paste Seed A again, restart voice, and repeat only the tempo request.
  Reload the page if the controls cannot recover; keep the room URL and a copy
  of your score.
- **Still failing:** stop voice and say, “The live service is unavailable; this
  is the prepared result.” Paste Seed A, change its tempo to `108`, and replace
  its music line with the supplied lowered version above. Show
  rendering/playback manually. Do **not** present this as a successful live AI
  edit. If playback cannot load, show the notation and state that audio is
  unavailable.

## What this demo actually exercises

The browser sends the current score as context. The Rust route configures
`gpt-live-1` with a delegated `gpt-5.6-luna` backend and one tool,
`replace_score`, which replaces the complete ABC document. Edits flow through
the existing shared editor. This runbook adds no hidden model instructions,
melody retrieval, or pre-recorded voice responses. See
[the browser integration](../src/lib/liveAgent.ts) and
[the server configuration](../cstudio-server/src/live_session.rs).
