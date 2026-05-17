# @tifan/pi-inline-skills

Inline `$skill` autocomplete in the pi editor.

Type `$` followed by a skill name fragment to open a fuzzy-matched picker of available skills. On submit, each `$name` token is replaced with the skill name and an instruction to load it is appended to the system prompt for that turn. Skills read during the session are tracked so they aren't reloaded.

## Install

```bash
pi install npm:@tifan/pi-inline-skills
```

## Commands

- `/loaded-skills`: List skills loaded in the current session.

## Example

Typing `let's $tdd this and $review when done` submits with the message rewritten and a single instruction added behind the scenes to load both skills.

## License

[MIT](LICENSE)
