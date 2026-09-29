import { afterEach, expect, test } from "bun:test"
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { skillNameForSuccessfulRead } from "../src/read-tracking.ts"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

test("a successful read through a symlink resolves to the catalog skill", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-read-tracking-"))
  directories.push(root)
  const skillDirectory = join(root, "actual", "research")
  const linkDirectory = join(root, "linked")
  mkdirSync(skillDirectory, { recursive: true })
  mkdirSync(linkDirectory)
  const actual = join(skillDirectory, "SKILL.md")
  const link = join(linkDirectory, "research.md")
  writeFileSync(actual, "skill")
  symlinkSync(actual, link)

  expect(
    skillNameForSuccessfulRead(
      { toolName: "read", isError: false, path: link },
      [{ name: "research", path: actual }],
      root,
    ),
  ).toBe("research")
})

test("failed reads and non-read tools do not mark a skill loaded", () => {
  const skill = { name: "research", path: "/skills/research/SKILL.md" }
  expect(
    skillNameForSuccessfulRead(
      { toolName: "read", isError: true, path: skill.path },
      [skill],
      "/",
    ),
  ).toBeUndefined()
  expect(
    skillNameForSuccessfulRead(
      { toolName: "write", isError: false, path: skill.path },
      [skill],
      "/",
    ),
  ).toBeUndefined()
})
