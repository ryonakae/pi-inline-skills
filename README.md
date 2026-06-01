# @tifan/pi-inline-skills

Inline `/skill` autocomplete in the pi editor.

Type `/` followed by a skill name fragment to open a fuzzy-matched picker of available skills. On submit, each `/name` token is replaced with the skill name and an instruction to load it is appended to the system prompt for that turn. Skills read during the session are tracked so they are not reloaded.

[add image: inline skill autocomplete]

- The `/` autocomplete picker filtered to a few skills.
- The submitted prompt after skill tokens are rewritten.

## Install

```bash
pi install npm:@tifan/pi-inline-skills
```

## Commands

- `/loaded-skills`: List skills loaded in the current session.

## Example

Typing `/tdd fix this` or `let's /tdd this and /review when done` submits with the message rewritten and a single instruction added behind the scenes to load the matching skills.

If the prompt starts with a registered pi command, that command wins. Otherwise, a starting token like `/tdd` is treated as an inline skill.

[add image: loaded skills command]

- The `/loaded-skills` output.

## Release notes

See [CHANGELOG.md](CHANGELOG.md)

## License

[MIT](LICENSE)
