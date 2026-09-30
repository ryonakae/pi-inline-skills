import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  effectiveLoadedSkillNames,
  restoreLoadedSkillNames,
} from "../src/loaded-skills.ts"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true })
})

const skillBlock = (name: string): string =>
  `<skill name="${name}" location="/skills/${name}/SKILL.md">\n${name} body\n</skill>`

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

test("effective loads come from projected inline and native bodies, not source metadata", () => {
  const projection = {
    entries: [
      {
        sourceEntry: {
          type: "custom_message",
          customType: "inline-skill",
          details: { names: ["inline-kept"] },
        },
        messages: [
          {
            role: "custom",
            customType: "inline-skill",
            content: skillBlock("inline-kept"),
          },
        ],
      },
      {
        sourceEntry: {
          type: "custom_message",
          customType: "inline-skill",
          content: skillBlock("inline-removed"),
          details: { names: ["inline-removed"] },
        },
        messages: [
          {
            role: "custom",
            customType: "inline-skill",
            content: "replacement without a skill body",
          },
        ],
      },
      {
        sourceEntry: {
          type: "message",
          message: { role: "user", content: skillBlock("native-removed") },
        },
        messages: [
          { role: "user", content: "replacement without a skill body" },
        ],
      },
      {
        sourceEntry: {
          type: "message",
          message: { role: "user", content: skillBlock("native-kept") },
        },
        messages: [{ role: "user", content: skillBlock("native-kept") }],
      },
    ],
  }

  expect(
    [...effectiveLoadedSkillNames(projection, [], "/")].toSorted(),
  ).toEqual(["inline-kept", "native-kept"])
})

test("effective successful reads require a projected result and matching call or current record", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-loaded-skills-"))
  directories.push(root)
  const skillDirectory = join(root, "read-skill")
  mkdirSync(skillDirectory)
  const path = join(skillDirectory, "SKILL.md")
  writeFileSync(path, "READ SKILL BODY")
  const result = {
    role: "toolResult",
    toolCallId: "read-paired",
    toolName: "read",
    content: [{ type: "text", text: "READ SKILL BODY" }],
    isError: false,
  }
  const resultOnly = {
    ...result,
    toolCallId: "read-result-only",
  }
  const editedResult = {
    ...result,
    toolCallId: "read-edited",
  }
  const projection = {
    entries: [
      {
        sourceEntry: { type: "message", message: { role: "assistant" } },
        messages: [
          {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "read-paired",
                name: "read",
                arguments: { path },
              },
              {
                type: "toolCall",
                id: "read-edited",
                name: "read",
                arguments: { path },
              },
            ],
          },
        ],
      },
      {
        sourceEntry: { type: "message", message: result },
        messages: [result],
      },
      {
        sourceEntry: { type: "message", message: resultOnly },
        messages: [resultOnly],
      },
      {
        sourceEntry: { type: "message", message: editedResult },
        messages: [
          {
            ...editedResult,
            content: [{ type: "text", text: "replacement without the body" }],
          },
        ],
      },
      {
        sourceEntry: {
          type: "custom",
          customType: "loaded-skill",
          data: {
            name: "read-skill",
            source: "tool-result",
            toolCallId: "read-result-only",
          },
        },
        messages: [],
      },
      {
        sourceEntry: {
          type: "custom",
          customType: "loaded-skill",
          data: { name: "metadata-only", source: "tool-result" },
        },
        messages: [],
      },
    ],
  }

  expect([
    ...effectiveLoadedSkillNames(
      projection,
      [{ name: "read-skill", path }],
      root,
    ),
  ]).toEqual(["read-skill"])
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
