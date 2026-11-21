# Translitera – offline translation prototype

A browser test of the Translitera conversation mode: Finnish ⇄ Ukrainian or Russian, with all speech recognition and translation running **on the phone**. Its purpose is to answer one question before we build the native app: are on-device models fast and accurate enough for a neuvola appointment?

This is a test tool, not the product. The look follows the Translitera mock-up, but the flow is built for measuring things.

## How to use it on an iPhone

1. Open the link in **Safari** (iOS 26 or later recommended – it has WebGPU).
2. Tap **Share → Add to Home Screen**, then open the app from the home screen. Safari keeps downloaded models more reliably for home-screen apps.
3. Tap **Download and start** while on Wi-Fi. The first download is about 0.7 GB (Whisper base + OPUS-MT). Keep the screen on until it finishes.
4. **Always on:** tap the speaker once and just talk – it detects who speaks which language, translates and speaks the translation. Tap again to pause.
   Or tap **Suomi** / **Українська**, speak and tap again; or use **Test phrases** / **Type instead**.
5. Rate each translation: **Good**, **Understandable** or **Wrong**.
6. Switch on flight mode and try again – it should still work.
7. Settings → **Export test results** sends a JSON file (via the share sheet) for analysis.

To hear translations, the phone needs the voices installed: *Settings › Accessibility › Spoken Content › Voices* (Finnish, Ukrainian, Russian). The prototype uses the iPhone's own voices – Oksana's AI voice comes later in the native app.

## Settings to compare

| Setting | Options | Notes |
|---|---|---|
| Other language | Ukrainian, Russian | |
| Translation engine | OPUS-MT via English (~0.45 GB) / NLLB-200 direct (~0.9 GB) | NLLB may be too large for older iPhones |
| Speech recognition | Whisper base (~0.2 GB) / Whisper small (~0.5 GB) | small is more accurate but slower |
| Show the English step | on / off | shows the intermediate English for OPUS-MT |

## Privacy

- Audio and text never leave the phone. There is no server, no analytics and no logging.
- The only network traffic is downloading the app files (GitHub Pages) and the AI models (Hugging Face) – once.
- The conversation is stored in the browser's local storage on this phone only, so test results survive a reload. **Clear conversation** in Settings deletes it. Do not use real patient conversations with this prototype; use the test phrases or role-play.

## Technical notes

- Models run with [Transformers.js](https://github.com/huggingface/transformers.js) 4.3 (ONNX Runtime Web) in a Web Worker. WebGPU is used when available, otherwise WebAssembly (single thread, because GitHub Pages cannot set cross-origin isolation headers).
- OPUS-MT has no direct Finnish–Ukrainian or Finnish–Russian ONNX models, so it translates via English (two steps). NLLB translates directly.
- A service worker caches the app shell; Transformers.js caches the models in the browser cache.
- Files: `index.html`, `css/app.css`, `js/app.js` (UI, microphone, speech output), `js/worker.js` (AI), `js/phrases.js` (neuvola test sentences), `sw.js`, `lib/` (Transformers.js + ONNX Runtime).

## Known risks to check

- Memory: iOS may kill the page when loading NLLB (~0.9 GB) or Whisper small.
- en→uk OPUS-MT may sometimes output empty or repeated text.
- Speed on WebAssembly (no WebGPU) may be too slow for conversation.

## Licences

| Component | Licence |
|---|---|
| Transformers.js | Apache-2.0 |
| ONNX Runtime Web | MIT |
| Whisper (OpenAI) | MIT |
| OPUS-MT (Helsinki-NLP) | CC-BY-4.0 – attribution required |
| NLLB-200 (Meta) | **CC-BY-NC-4.0 – non-commercial only.** Fine for testing; cannot ship in the paid product without a different model or licence. *(Question for a lawyer.)* |

Translitera logo and branding © Translitera. Not for reuse.
