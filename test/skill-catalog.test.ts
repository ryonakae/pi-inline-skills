import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { isAutomaticSkillCandidate } from "../src/skill-catalog.ts"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

function skillFile(name: string, frontmatter = ""): string {
  const root = mkdtempSync(join(tmpdir(), "pi-skill-catalog-"))
  directories.push(root)
  const directory = join(root, name)
  mkdirSync(directory)
  const path = join(directory, "SKILL.md")
  writeFileSync(
    path,
    `---\nname: ${name}\ndescription: ${name} description\n${frontmatter}---\nbody\n`,
  )
  return path
}

test("automatic candidates respect disable-model-invocation and exclusions", () => {
  const ordinary = { name: "ordinary", path: skillFile("ordinary") }
  const disabled = {
    name: "manual-only",
    path: skillFile("manual-only", "disable-model-invocation: true\n"),
  }
  const disabledWithComment = {
    name: "commented-manual-only",
    path: skillFile(
      "commented-manual-only",
      "disable-model-invocation: true # manual only\n",
    ),
  }
  const excluded = { name: "plan", path: skillFile("plan") }

  expect(isAutomaticSkillCandidate(ordinary, new Set())).toBe(true)
  expect(isAutomaticSkillCandidate(disabled, new Set())).toBe(false)
  expect(isAutomaticSkillCandidate(disabledWithComment, new Set())).toBe(false)
  expect(isAutomaticSkillCandidate(excluded, new Set(["plan"]))).toBe(false)
})

test("an unreadable skill is not sent as an automatic candidate", () => {
  expect(
    isAutomaticSkillCandidate(
      { name: "missing", path: "/missing/SKILL.md" },
      new Set(),
    ),
  ).toBe(false)
})
