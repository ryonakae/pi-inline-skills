# @tifan/pi-inline-skills

Load multiple skills from inside your prompt.

`pi-inline-skills` adds `/skill` autocomplete to the pi editor. Type `/` with part of a skill name, choose one or more matches, and keep writing. When you submit, the extension loads those skills for that turn.

![Inline skill autocomplete picker](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-inline-skills/assets/skills-selector-triggered-inline.webp)

## Install

```bash
pi install npm:@tifan/pi-inline-skills
```

## How it works

- Type `/` followed by part of a skill name to open the picker.
- Choose one or more skills while writing your prompt.
- On submit, each `/name` token is replaced with the skill name, and matching skill content is added behind the scenes.
- Skills loaded during the session are tracked, so they are not injected again.
- Skills with `disable-model-invocation: true` work because inline loading uses the skill file directly instead of relying on the model-visible skills list.
- If the prompt starts with a registered pi command, that command wins. Otherwise, a starting token like `/tdd` is treated as an inline skill.

## Commands

- `/loaded-skills`: List skills loaded in the current session.

## Example

Typing this:

```text
let's /tdd this and /review when done
```

submits the prompt with `tdd` and `review` selected as skills to load. The visible message stays readable, and the load instruction is handled outside your prompt text.

![Loaded skills command output](https://raw.githubusercontent.com/tifandotme/pi-extensions/refs/heads/master/packages/pi-inline-skills/assets/loaded-skills-output.webp)

Use `/loaded-skills` to see which skills have already been read in the current session.

## Release notes

See [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
