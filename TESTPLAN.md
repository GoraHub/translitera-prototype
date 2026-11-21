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

## Always-on round (the speaker)

The product translates continuously, so this round matters most. Put the phone on the table between the two speakers, tap the speaker once, and talk normally. Nobody touches the phone.

Check and note:
- **Sentences cut right?** Does it wait for the end of a sentence, or cut people off mid-thought? Try the pause setting at 0.6 s, 0.8 s and 1.2 s.
- **Language detected right?** Every card should show the right direction (Suomi → Українська or back). Count wrong directions. "Language re-checked" means it caught a Ukrainian/Russian mix-up itself.
- **Wait time.** "Wait" on each card is the time from the end of speech to the start of the translation. Target: under 3 s.
- **Loud enough?** With "switch microphone off while speaking" on and off. iPhones may play the voice quietly while the microphone is on.
- **Talking over each other / background noise.** Does it translate noise, coughs or a crying baby? Does a person speaking during the translation get lost?
- **Screen stays on** for a 10-minute conversation.

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
