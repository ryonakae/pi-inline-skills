# Pi Inline Skills

This is an independently maintained fork of [Tifan Dwi Avianto's `pi-inline-skills`](https://github.com/tifandotme/pi-extensions/tree/d753b5c6e7a32534c8ff84cb1059d98cb2731f28/packages/pi-inline-skills), extracted from `tifandotme/pi-extensions` with its history and MIT license intact.

The main changes from upstream are:

- Optional Jev skill recommendations in the main session, loaded through Pi's standard `read` tool rather than automatic body insertion.
- Bounded, sanitized selection context, explicit-only skill exclusions, and child-session detection shared with the [pi-subagents fork](https://github.com/ryonakae/pi-subagents/tree/feat/jev-routing).
- Manual skill loading tied to the input Pi actually consumes, preventing failed or cancelled inputs from leaking skill bodies into later requests. Existing `/skill-name` completion and loaded-skill tracking remain available.

These changes are maintained for this fork's own use, rather than as an upstream pull request. Jev is off by default. See [UPSTREAM.md](UPSTREAM.md) for provenance and update guidance.

Load Pi skills anywhere in a prompt, with optional Jev-based suggestions.

Type an inline `/skill-name` token to keep writing without replacing your prompt. When enabled, Jev recommends up to three supporting skills and asks the model to load them with Pi's standard `read` tool.

![Inline skill autocomplete picker](https://raw.githubusercontent.com/ryonakae/pi-inline-skills/refs/heads/master/assets/skills-selector-triggered-inline.webp)

## Install

```bash
pi install git:github.com/ryonakae/pi-inline-skills@feat/jev-routing
```

The Jev integration is maintained on `feat/jev-routing`; `master` preserves the extracted upstream code with standalone provenance and licensing.

The package requires Pi 0.87.1 or later and Node.js 22.19 or later.

## Quickstart

Type `/` and part of a skill name, choose a completion, and continue the same prompt:

```text
let's /tdd this and /review when done
```

The extension leaves Pi's prompt expansion unchanged. For a normal input, it resolves manual tokens from the expanded prompt and inserts the matching skill contents as a visible custom message before Pi calls the model. For queued steering and follow-up inputs, it provides the body in the corresponding model request, then Pi saves and displays the same custom message at turn end. A failed preflight or a cleared queue does not reserve skills for another input.

Pi handles native `/skill:name` expansion. Slash references inside expanded skill bodies do not request additional manual loads.

Run `/loaded-skills` to list skills loaded on the current session branch.

## Automatic selection with Jev

Automatic selection is off by default. Create the global configuration at `~/.pi/agent/extensions/pi-inline-skills/config.json`:

```json
{
  "jev": {
    "enabled": true,
    "model": "jev-1.13.0",
    "timeoutMs": 5000,
    "minRelevance": 0.85,
    "maxRequestBytes": 65536,
    "maxSkills": 3,
    "historyMessages": 6,
    "historyChars": 12000,
    "excludedSkills": [
      "ask-codex",
      "commit-push",
      "doc-updater",
      "herdr",
      "implement",
      "plan"
    ]
  }
}
```

Set `TYPESAFE_API_KEY` in the environment that starts Pi. Reload Pi resources with `/reload`, or start a new session, after changing the configuration.

For each consumed batch of user messages, the extension sends at most one POST to `https://api.typesafe.ai/v1/systemone`. Provider retries reuse the decision, including failures and no-match results. Queuing an input alone does not send it. The request contains:

- the consumed request text after Pi's skill and template expansion, including user messages from other extensions;
- up to `historyMessages` user and assistant text messages including the current batch, bounded by `historyChars`, without duplicating the current messages;
- candidate skill names and descriptions;
- explicitly requested and already loaded skill names.

It excludes tool results, thinking blocks, images, expanded skill contents, and custom messages. It removes all skill blocks from both current and historical text; malformed or unclosed blocks cause the whole containing text to be omitted. This does not identify secrets quoted in arbitrary prose. It sends the API key only in the `Authorization` header. Diagnostics contain skill names, Noul scores, latency, truncation state, and failure categories; they do not contain the key, conversation text, input text, or API error bodies.

Each candidate receives a Noul score in the same request. Jev recommends skills at or above `minRelevance` in descending score order, up to `maxSkills`. The extension adds their names and file paths to a request-local instruction to use `read`; it does not insert their bodies, invent tool results, or mark them loaded. The model may decline to read them. Successful reads remove the corresponding instructions. New consumed inputs, aborts, run completion, and branch/session changes invalidate old recommendations. These instructions are not saved in session history.

The extension skips requests exceeding `maxRequestBytes` rather than silently removing candidates. With Jev disabled, it makes no Jev HTTP requests.

Automatic selection requires the read-only `globalThis[Symbol.for("pi-subagents:child-context")]` version 1 contract supplied by a compatible `pi-subagents`. Missing or incompatible contracts disable only automatic selection. Child sessions never call Jev. Explicit inline skills, Pi's native `/skill:name` command, catalog access, completion, and `/loaded-skills` remain available.

## Loading rules

- Manual insertion, native expansion, and successful `read` results establish loaded state on the active branch. The extension suppresses repeated manual insertion and recommendations for those skills, including after reload and compaction. Recommendations alone and failed reads do not establish loaded state. Pi still controls native expansion.
- `excludedSkills` and `disable-model-invocation: true` affect automatic selection only. Explicit `/skill-name` tokens still load those skills.
- Pi dispatches registered commands before the extension handles an accepted agent prompt. Matching slash tokens in the final expanded request are manual skill requests, even when a template produced a command-like prefix.
- Jev errors, timeouts, invalid responses, and missing credentials skip automatic selection without discarding explicit skills.
- All-at-once queues process the whole consumed user batch. Request-local manual injection and saved-message deduplication are separate, so retries retain the body without duplicate display or storage.
- Pi saves queued manual bodies already supplied to a request even when that turn errors or aborts. Unconsumed or cleared inputs have no pending bodies to leak into later requests.

![Loaded skills command output](https://raw.githubusercontent.com/ryonakae/pi-inline-skills/refs/heads/master/assets/loaded-skills-output.webp)

## Provenance

This repository preserves the history of [`packages/pi-inline-skills`](https://github.com/tifandotme/pi-extensions/tree/d753b5c6e7a32534c8ff84cb1059d98cb2731f28/packages/pi-inline-skills) from `tifandotme/pi-extensions`. The extraction baseline is upstream commit `d753b5c6e7a32534c8ff84cb1059d98cb2731f28`; the initial filtered HEAD is `689b311ff6cb093acdf7c6d3dac5ffa720e0904a`.

See [UPSTREAM.md](UPSTREAM.md) for the repeatable update procedure.

## License

[MIT](LICENSE). Copyright remains with the original author, Tifan Dwi Avianto.
