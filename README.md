# @tifan/pi-inline-skills

Load skills from inside a pi prompt.

Type `/` and part of a skill name, pick a skill, then keep writing. On submit, the prompt stays unchanged and the matching skill content is loaded for that turn.

![Inline skill autocomplete picker](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-inline-skills/assets/skills-selector-triggered-inline.webp)

## Install

```bash
pi install npm:@tifan/pi-inline-skills
```

## Usage

```text
let's /tdd this and /review when done
```

This loads `tdd` and `review` behind the scenes. Slash tokens stay in the visible prompt, so rewinding and editing previous prompts is easy.

Notes:

- Already-loaded skills are not injected again on the same session branch.
- Skills with `disable-model-invocation: true` work because this extension reads skill files directly.
- A registered pi command wins at the start of a prompt. Otherwise, a starting token like `/tdd` is treated as an inline skill.

## Commands

- `/loaded-skills`: List skills loaded in the current session.

![Loaded skills command output](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-inline-skills/assets/loaded-skills-output.webp)

## Release notes

See [CHANGELOG.md](https://github.com/tifandotme/pi-extensions/blob/master/packages/pi-inline-skills/CHANGELOG.md)

## License

[MIT](https://github.com/tifandotme/pi-extensions/blob/master/LICENSE)
