import { readFileSync } from "node:fs"
import { parseFrontmatter } from "@earendil-works/pi-coding-agent"

export type AutomaticSkillCandidate = {
  name: string
  path: string | undefined
}

export function isAutomaticSkillCandidate(
  skill: AutomaticSkillCandidate,
  excludedSkills: ReadonlySet<string>,
): boolean {
  if (excludedSkills.has(skill.name) || !skill.path) return false
  try {
    const { frontmatter } = parseFrontmatter(readFileSync(skill.path, "utf-8"))
    return frontmatter["disable-model-invocation"] !== true
  } catch {
    return false
  }
}
