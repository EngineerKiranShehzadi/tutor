# AI teacher avatar

A presentation layer on top of the existing chat. It never changes answer text,
sources, agent selection or any RAG behaviour — it only receives the **final,
guardrail-checked** answer and speaks it.

## How it fits together

```
useChat (existing) ──onFinalAnswer(finalText)──▶ useAvatarSpeech ──▶ SpeechController ──▶ browser speechSynthesis
        │ isAnswerPending                              │ getMouth()  (text-derived viseme timeline)
        ▼                                              ▼
 deriveAvatarState ──▶ TeacherAvatarPanel ──▶ AvatarCanvas (React Three Fiber + @pixiv/three-vrm)
                                                   └─ AvatarPoseDriver (procedural pose + expressions)
```

| File | Role |
|---|---|
| `lip-sync.ts` | text → approximate viseme timeline, sampler, mouth smoother |
| `speech-controller.ts` | one TTS engine: play / pause / resume / stop / replay / mute, stale-callback guard |
| `avatar-state.ts` | IDLE / LISTENING / THINKING / SPEAKING / ERROR derivation + pose driver |
| `agent-identity.ts` | lecture → displayed agent name (existing frontend mapping) |
| `webgl.ts` | WebGL probe for the 2D fallback |
| `components/avatar/AvatarCanvas.tsx` | VRM loading, bone/expression application, disposal |
| `components/avatar/TeacherAvatarPanel.tsx` | UI, controls, loading/error/fallback states |
| `app/avatar-preview/page.tsx` | standalone QA page (no login) |

## Presentation modes (`AVATAR_MODE` in `config.ts`)

| Mode | What it is | Lip movement |
|---|---|---|
| `portrait` (default) | A 2D portrait animated in `PortraitAvatar.tsx`: breathing, head sway, speech-driven mouth overlay (blink overlay; the instructor variant is split into a still body layer and a head layer that pivots at the neck, so the figure does not float). Variant chosen by `ACTIVE_PORTRAIT`: `instructor` (default) or `cartoon` | Mouth opening follows the same approximate viseme timeline |
| `vrm` | A rigged 3D VRM model rendered with WebGL (`AvatarCanvas.tsx`) | Real VRM mouth blendshapes |

The portrait is **not 3D**: eyelids and mouth are overlays on one still image.
For a true 3D teacher in that style, a rigged model with face blendshapes
(VRM, or a GLB with viseme morph targets plus a small adapter) must be supplied.

## Behaviour

- Shown at the top of the chat column on the lecture page; Hide / Show toggle (remembered).
- Speaks automatically when a final answer arrives (unless muted). If the
  browser blocks audio, a clear message and the Play button are shown.
- Switching lecture or chat session stops speech immediately.
- Only one voice at a time: while the avatar is shown, the older "auto-speak"
  and per-message Speak buttons route through the avatar's single voice.
- Arms hang straight down in every state. Small arm gestures while speaking are
  available behind `ARM_GESTURES_ENABLED` in `config.ts` (off by default).
- If WebGL is unavailable or the model fails to load, a 2D fallback card with
  the same controls is shown.

## Honest limitations

- **Lip sync is approximate.** `speechSynthesis` exposes no audio and no
  phoneme timing. Mouth shapes come from the answer's spelling and are re-aligned
  on word-boundary events when the browser provides them. Not phoneme-accurate.
- Gestures (when enabled) are procedural and not matched to meaning.
- Voice quality / availability depends on the viewer's browser and OS.
- The bundled model is a stylised anime-style character (see `public/avatar/ATTRIBUTION.md`).
- No eyebrow control (the VRoid model has no brow expressions).

## Tests

```bash
cd frontend
../backend/node_modules/.bin/ts-node --transpile-only --skip-project \
  --compiler-options '{"module":"commonjs","target":"es2020"}' src/lib/avatar/avatar.test.ts
npm run typecheck
```

## Manual checklist (needs a real browser with audio)

1. Open `/lecture/<id>` of a READY lecture: avatar appears at the top of the chat column, named after the lecture's agent.
2. Ask a question: status shows Thinking, then Speaking when the final answer arrives; text answer and sources stay visible.
3. Pause / Resume / Stop / Replay / Mute behave; mouth stops on pause and stop.
4. Switch lecture or chat session while speaking: speech stops.
5. Block autoplay / disable audio: message + Play button appear.
6. Disable WebGL (chrome://flags) or hide the avatar: chat still works.
7. Judge lip-sync quality by eye and ear — automated tests cannot.
