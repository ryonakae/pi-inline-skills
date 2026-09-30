# Pi Inline Skills

This is an independently maintained fork of [Tifan Dwi Avianto's `pi-inline-skills`](https://github.com/tifandotme/pi-extensions/tree/d753b5c6e7a32534c8ff84cb1059d98cb2731f28/packages/pi-inline-skills), extracted from `tifandotme/pi-extensions` with its history and MIT license intact.

The main changes from upstream are:

- Optional Jev skill selection through TypeSafe or OpenRouter in the main session. Selected skill bodies are inserted into the current model request and saved as hidden session messages. OpenRouter uses Pi's standard provider authentication.
- Bounded, sanitized selection context, explicit-only skill exclusions, and child-session detection shared with the [pi-subagents fork](https://github.com/ryonakae/pi-subagents/tree/feat/jev-routing).
- Manual skill loading tied to the input Pi actually consumes, preventing failed or cancelled inputs from leaking skill bodies into later requests. Existing `/skill-name` completion and loaded-skill tracking remain available.

These changes are maintained for this fork's own use, rather than as an upstream pull request. Jev is off by default. See [UPSTREAM.md](UPSTREAM.md) for provenance and update guidance.

Load Pi skills anywhere in a prompt, with optional Jev-based suggestions.

Type an inline `/skill-name` token to keep writing without replacing your prompt. When enabled, Jev selects and loads up to three supporting skill bodies before the model responds.

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

Run `/loaded-skills` to list the historical skills loaded on the current session branch. This list is an audit of branch usage, not a claim that every body still exists in the current model context.

## Automatic selection with Jev

Automatic selection is off by default. Create the global configuration at `~/.pi/agent/extensions/pi-inline-skills/config.json`:

```json
{
  "jev": {
    "enabled": true,
    "provider": "typesafe",
    "model": "jev-1.13.0",
    "timeoutMs": 5000,
    "minRelevance": 0.85,
    "maxRequestBytes": 65536,
    "maxSkills": 3,
    "historyMessages": 6,
    "historyChars": 12000,
    "excludedSkills": []
  }
}
```

`jev.provider` accepts `"typesafe"` (the default) or `"openrouter"`. The provider fixes the endpoint and the model used when `jev.model` is omitted:

| Provider     | Endpoint                                 | Default model       | Authentication                 |
| ------------ | ---------------------------------------- | ------------------- | ------------------------------ |
| `typesafe`   | `https://api.typesafe.ai/v1/systemone`   | `jev-1.13.0`        | `TYPESAFE_API_KEY`             |
| `openrouter` | `https://openrouter.ai/api/v1/systemone` | `typesafe/jev-1.13` | Pi's OpenRouter authentication |

An explicit `jev.model` is preserved when changing providers. Unknown providers disable Jev as an invalid configuration; the extension never falls back to another provider.

For TypeSafe, set `TYPESAFE_API_KEY` in the environment that starts Pi. For OpenRouter, run `/login openrouter` in Pi or set `OPENROUTER_API_KEY` before starting Pi. Pi resolves OpenRouter credentials using its standard priority: a runtime API key, a saved credential, `models.json`, then the environment. A saved credential therefore takes priority over `OPENROUTER_API_KEY`. The extension does not read or write `auth.json` itself.

For example, an OpenRouter configuration can omit the provider-default model:

```json
{
  "jev": {
    "enabled": true,
    "provider": "openrouter",
    "timeoutMs": 5000,
    "minRelevance": 0.85,
    "maxRequestBytes": 65536,
    "maxSkills": 3,
    "historyMessages": 6,
    "historyChars": 12000
  }
}
```

Reload Pi resources with `/reload`, or start a new session, after changing the configuration.

For each consumed batch of user messages, the extension resolves credentials only after finding candidates, then sends at most one POST to the configured provider endpoint. Provider retries reuse the decision, including pending authentication, failures, and no-match results. Queuing an input alone does not send it. Disabled Jev, child sessions, batches without candidates, zero `maxSkills`, and completed batches do not resolve OpenRouter credentials. The request contains:

- the consumed request text after Pi's skill and template expansion, including user messages from other extensions;
- up to `historyMessages` user and assistant text messages including the current batch, bounded by `historyChars`, without duplicating the current messages;
- candidate skill names and descriptions;
- explicitly requested and already loaded skill names.

It excludes tool results, thinking blocks, images, expanded skill contents, and custom messages, including hidden automatically loaded bodies. It removes all skill blocks from both current and historical text; malformed or unclosed blocks cause the whole containing text to be omitted. This does not identify secrets quoted in arbitrary prose. It sends the API key only in the `Authorization` header. Routine candidate, score, latency, truncation, and no-match diagnostics are not displayed. Failures are reported by sanitized category without the key, conversation text, input text, authentication errors, or API error bodies.

`timeoutMs` covers the System One HTTP request and response-body read. OpenRouter credential resolution happens before that timeout and follows Pi's standard behavior. In particular, a saved `!command` credential runs synchronously with Pi's own timeout of up to 10 seconds and is cached for the process lifetime, so a `timeoutMs` of 5000 does not impose a five-second limit on authentication plus HTTP combined. If the request is aborted or its session or input batch changes while authentication is pending, the extension does not start the HTTP request afterward.

Each candidate receives a Noul score in the same request. The extension loads skills at or above `minRelevance` in descending score order, up to `maxSkills`. It reads each selected `SKILL.md`, inserts the existing inline skill block into that model request, and queues the same content as an `inline-skill` custom message with `display: false`. It does not invent tool calls or tool results. After Pi confirms persistence, one notification reports the successfully loaded names, for example `inline-skills: loaded use-zellij, worktrunk by Jev`. Unreadable files produce an error notification; readable selections still load together. No match is silent. New consumed inputs, aborts, run completion, and branch/session changes invalidate stale selections. Provider retries reuse both the Jev decision and the already built body without duplicate storage or notification.

The extension skips requests exceeding `maxRequestBytes` rather than silently removing candidates. With Jev disabled, it makes no Jev HTTP requests.

Automatic selection requires the read-only `globalThis[Symbol.for("pi-subagents:child-context")]` version 1 contract supplied by a compatible `pi-subagents`. Missing or incompatible contracts disable only automatic selection. Child sessions never call Jev. Explicit inline skills, Pi's native `/skill:name` command, catalog access, completion, and `/loaded-skills` remain available.

## Loading rules

- Manual insertion, automatic insertion, native expansion, and successful `read` results establish effective loaded state only while their actual body remains in Pi's projected context. The extension recomputes this state for each load decision. A compaction or context edit that removes a body makes the skill eligible again; a retained body still suppresses duplicates. Historical names, summaries, and metadata alone do not suppress loading, and the extension does not eagerly restore every previously used skill after compaction. Pi still controls native expansion.
- `/loaded-skills` remains a branch-history list across compaction and context edits, so it can include names whose bodies are no longer effective.
- `excludedSkills` and `disable-model-invocation: true` affect automatic selection only. Explicit `/skill-name` tokens still load those skills. Use `"excludedSkills": []` for no name-based exclusions; omitting the setting keeps the package default unchanged.
- Pi dispatches registered commands before the extension handles an accepted agent prompt. Matching slash tokens in the final expanded request are manual skill requests, even when a template produced a command-like prefix.
- Jev errors, timeouts, invalid responses, and missing or failed credentials skip automatic selection without discarding explicit skills. Credentials are never borrowed from the other provider.
- All-at-once queues process the whole consumed user batch. Manual and automatic request-local injection have independent saved-message deduplication, so neither suppresses the other and retries retain each body without duplicate display, storage, or success notification.
- Pi saves queued bodies already supplied to a request even when that turn errors or aborts. Unconsumed or cleared inputs have no pending bodies to leak into later requests.
- Loading a skill provides instructions to the model; it does not bypass the skill's execution conditions, approval requirements, sandbox, or tool permissions.

![Loaded skills command output](https://raw.githubusercontent.com/ryonakae/pi-inline-skills/refs/heads/master/assets/loaded-skills-output.webp)

## Provenance

This repository preserves the history of [`packages/pi-inline-skills`](https://github.com/tifandotme/pi-extensions/tree/d753b5c6e7a32534c8ff84cb1059d98cb2731f28/packages/pi-inline-skills) from `tifandotme/pi-extensions`. The extraction baseline is upstream commit `d753b5c6e7a32534c8ff84cb1059d98cb2731f28`; the initial filtered HEAD is `689b311ff6cb093acdf7c6d3dac5ffa720e0904a`.

See [UPSTREAM.md](UPSTREAM.md) for the repeatable update procedure.

## License

[MIT](LICENSE). Copyright remains with the original author, Tifan Dwi Avianto.
