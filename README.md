# Three-Lane Probe

## What is this?

A live viewport that asks one question three ways: plain, with the public demo fixture, and with a length-matched control. Grok answers each lane. The page keeps the messages and their hashes.

**Status: the published page is live.** This repository is the viewport source. It is not the Python harness, and it is not a quality score.

## Why care?

A longer prompt can change an answer even when the added text does nothing. Matching length separates "more characters" from "this fixture." The comparison is unblinded. It does not score quality, and fixture effectiveness stays unverified.

## Try this

**Try the app:** [Three-Lane Probe](https://cactus-umbra-vivid-lunar.grok.me/)

Open it, leave the sample question, check the quota box, and run. Each lane is its own call. A dropped connection keeps the lanes that already came back.

A run spends the app owner's xAI API credits. Other visitors do not bring their own key. The length lane repeats the word stone so it matches the public demo's fixed length. That is not xAI's tokenizer, and it is not meaningless text.

The hosted page and this source can drift until the builder app is published again. If the page still talks about a beauty pass and a LUT, that wording is the earlier viewport.

## What this repository is

| Piece | What it is |
| --- | --- |
| [The app](https://cactus-umbra-vivid-lunar.grok.me/) | The published viewport |
| [Assembly](src/lib/probe/protocol.ts) | Public DEMO messages, hashes, and the CRLF block |
| [Live calls](src/lib/probe/run-probe.ts) | One Grok call at a time. The key is not in this repository. |
| [Page](src/components/probe-app.tsx) | The viewport the published app shows |
| [Prompt Engineering Workbench](https://github.com/donaldtuttle/prompt-engineering-workbench) | The local Python harness. Separate project. |
| [Offline reconstruction](https://github.com/donaldtuttle/prompt-engineering-workbench/tree/main/examples/three_lane_probe) | The same public hashes, with no API key |

Do not import a run from this page into the harness as `workbench-experiment-v2`. The record here is `three-lane-live-v1`. Evaluation stays null. Resolution stays `INSUFFICIENT_EVIDENCE`.

## Verify the hashes

Node.js 22 or later. No install and no API key.

```sh
node --experimental-strip-types --test src/lib/probe/protocol.test.ts
```

Those tests check the published prompt hashes, the handshake prefixes, and the CRLF block. They do not call a model.

## Live calls

The page calls `grok-4.5` only after the quota box is checked. Thinking is low or medium. Visible output is capped at 160 tokens. Temperature and seed are omitted.

One tab stops at 4 runs. The server stops at 12 calls per 10 minutes. Nothing is retried on its own.

## License and permission

Copyright (c) 2026 Donald Tuttle. All rights reserved. Original project material is proprietary; use, modification, or redistribution requiring authorization needs Donald Tuttle's prior written permission. See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY_NOTICES.md). This is not an open source license.

A license does not make a public repository private. Never commit credentials or private injectors. The fixture in this repository is the published software-test text, not a private injector.
