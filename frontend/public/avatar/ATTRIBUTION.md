# Teacher avatar assets — attribution and license

## Default: `teacher-instructor.png` (instructor cut-out on an illustrated suit)

| | |
|---|---|
| What | The institute's instructor's photo (background removed, head and beard only) placed on a drawn cream kurta (Nehru/band collar, placket, pocket) — the earlier blue-suit version was replaced at the owner's request |
| Photo source | The instructor portrait used on the institute's own lecture thumbnails (e.g. https://i.ytimg.com/vi/pCNit2x2gjY/maxresdefault.jpg) |
| Permission | **Stated by the project owner** (the instructor/institute agreed to be shown). Not independently verified by the developer — keep written confirmation |
| Body | Drawn programmatically (flat cream kurta with simple shading); no third-party artwork used for the body |
| Made with | Simple colour/shape masking (no AI model); head scaled to the body and aligned by hand |
| Labelling | The avatar is presented in the UI as the lecture's **AI teacher** (agent name, "AI teacher"), not as the instructor speaking |

Because a photograph is combined with an illustrated body, the style is
intentionally "cut-out" rather than seamless. The speech is synthetic
(browser text-to-speech) and the content is AI-generated.

The previous illustrated portrait remains available: set `ACTIVE_PORTRAIT = 'cartoon'`
in `src/lib/avatar/config.ts`.

---

## Default presentation: `teacher-portrait.png` (2D animated portrait)

| | |
|---|---|
| What | The project owner's chosen reference: a Pixar-style illustration of a bearded teacher in a blue suit |
| Provenance | Supplied by the project owner. The original carries a `stablediffusionweb.com` caption, so it appears to be AI-generated with that site |
| Used as | Cropped to the head and upper body (240x304) and animated in 2D (breathing, head movement, blinking, speech-driven mouth) |
| License | **Not verified by the developer.** Check the generator's terms (and that you may use and show it) before a public release or submission |

This is an illustration, **not a 3D model**. Blinking and the open mouth are
overlays drawn on top of the still image.

To use a real 3D model instead, set `AVATAR_MODE = 'vrm'` in
`src/lib/avatar/config.ts` (see below).

---

# 3D model (used when `AVATAR_MODE = 'vrm'`)

| | |
|---|---|
| File | `teacher.vrm` (7.7 MB) |
| Original | `HairSample_Male.vrm` (18.5 MB) — a VRoid Studio male sample model |
| Source | https://github.com/madjin/vrm-samples — `vroid/beta/HairSample_Male.vrm` |
| Exporter | VRoidStudio 0.11.2 |
| Format | VRM 0.x (glTF 2.0 + `VRM`) |
| License | **CC0** — read from the model's own embedded VRM metadata |

Embedded VRM metadata (`extensions.VRM.meta`):

- `licenseName`: `CC0`
- `allowedUserName`: `Everyone`
- `commercialUssageName`: `Allow`

CC0 allows modification and redistribution without attribution.

## Modification made for this project

Only image data was changed: textures larger than 1024 px were downscaled
(PNG, re-encoded) and the VRM thumbnail reduced to 128 px, which cut the file
from 18.5 MB to 7.7 MB. Geometry, rig, expressions and VRM metadata are unchanged.

## Limitations of this asset

- It is a **stylised (VRoid / anime-style) character**, not a semi-realistic
  human teacher. It is a stand-in until a model that matches the intended
  look (see below) is supplied.
- It has no beard/glasses; the shipped look is a young male in a hoodie.

## Replacing the model

Put another VRM (0.x or 1.0) at `public/avatar/teacher.vrm`, or change
`AVATAR_MODEL_URL` in `src/lib/avatar/config.ts`. Check its license first.
The animation code uses only standard VRM humanoid bones and the standard
`aa / ih / ou / ee / oh / blink / happy` expressions, and frames the camera from
the model's own size, so most VRMs work unchanged.

A glTF/GLB avatar that is not a VRM (e.g. a Ready Player Me / Avaturn export)
is **not** supported yet: it would need a small adapter for its
`viseme_*` / ARKit morph targets and Mixamo-style bone names.
