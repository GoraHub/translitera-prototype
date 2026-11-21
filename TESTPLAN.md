# Test plan – offline translation prototype

**Goal:** decide whether on-device AI is good enough for a neuvola visit, and which models to use in the native app.

## Who and what

- 2 testers: one Finnish speaker (nurse role), one Ukrainian or Russian speaker (parent role). Oksana as quality judge.
- Phones: at least one recent iPhone (17-series) and one older iPhone (e.g. 12 or SE), to see the low end.
- Use only the test phrases or role-play. No real patient data.

## Rounds

| Round | Engine | Speech model | Language |
|---|---|---|---|
| A | OPUS-MT | Whisper base | Ukrainian |
| B | NLLB | Whisper base | Ukrainian |
| C | Best of A/B | Whisper small | Ukrainian |
| D | Best so far | Best so far | Russian |

In each round:
1. Read all **Test phrases** aloud (spoken, not tapped) – 10 Finnish, 10 other language.
2. Role-play a 5-minute neuvola visit freely: baby's sleep, feeding, a fever, vaccination, next appointment.
3. Rate every turn: Good / Understandable / Wrong.
4. Repeat 3 phrases in **flight mode**.
5. Export results after each round (Settings → Export test results) and name the file by round and phone.

## What to measure

| Measure | Target for "good enough" | Where it comes from |
|---|---|---|
| First download time | < 10 min on Wi-Fi | stopwatch |
| Recognition time | < 1.5 s for a 5 s sentence | card timings |
| Translation time | < 1.5 s | card timings |
| Ratings | ≥ 80 % Good, ≤ 5 % Wrong | ratings |
| Medical terms right | numbers, temperatures, medicine names, dates all correct | Oksana's review |
| Works offline | yes, every time | flight-mode test |
| Crashes / page reloads | none | note it |
| GPU or CPU | GPU on new phones | card shows GPU/CPU |

Also note: wrong recognitions (speech → text) vs wrong translations (text → text). The card shows both, so we know which model to improve.

## Decision after testing

- If one setup meets the targets on the new iPhone → use it as the baseline for the native app.
- If accuracy is the problem → test larger or fine-tuned models (Oksana's glossary of neuvola terms).
- If speed or memory is the problem → native app with Core ML / ANE, which is faster than the browser.
- NLLB is non-commercial; if it wins, we need a licensed alternative before launch.
