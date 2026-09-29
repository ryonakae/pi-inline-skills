import { expect, test } from "bun:test"
import { restoreLoadedSkillNames } from "../src/loaded-skills.ts"

test("branch entries restore inline, native, and successful-read skill names", () => {
  const entries = [
    {
      type: "custom_message",
      customType: "inline-skill",
      details: {
        names: ["inline-legacy"],
        skills: [
          {
            name: "inline-current",
            location: "/skills/inline-current/SKILL.md",
            content: "body",
          },
        ],
      },
    },
    {
      type: "message",
      message: {
        role: "user",
        content:
          '<skill name="native" location="/skills/native/SKILL.md">\nbody\n</skill>\n\ncontinue',
      },
    },
    {
      type: "custom",
      customType: "loaded-skill",
      data: { name: "read-skill", source: "tool-result" },
    },
    {
      type: "compaction",
      summary: "summary without raw skill contents",
    },
    {
      type: "message",
      message: {
        role: "assistant",
        content: '<skill name="not-user" location="/tmp/SKILL.md">body</skill>',
      },
    },
  ]

  expect([...restoreLoadedSkillNames(entries)].toSorted()).toEqual([
    "inline-current",
    "inline-legacy",
    "native",
    "read-skill",
  ])
})

test("every native block on a branch counts as loaded", () => {
  const content =
    '<skill name="alpha" location="/alpha/SKILL.md">\nALPHA\n</skill>\n\n<skill name="beta" location="/beta/SKILL.md">\nBETA\n</skill>\n\nrequest'
  expect([
    ...restoreLoadedSkillNames([
      { type: "message", message: { role: "user", content } },
    ]),
  ]).toEqual(["alpha", "beta"])
})

test("restoration uses only entries from the supplied current branch", () => {
  const mainBranch = [
    {
      type: "custom_message",
      customType: "inline-skill",
      details: { names: ["main-only"] },
    },
  ]
  const otherBranch: unknown[] = []

  expect([...restoreLoadedSkillNames(mainBranch)]).toEqual(["main-only"])
  expect([...restoreLoadedSkillNames(otherBranch)]).toEqual([])
})
