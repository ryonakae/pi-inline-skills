import { realpathSync } from "node:fs"
import { isAbsolute, resolve } from "node:path"

type ReadResult = {
  toolName: string
  isError: boolean
  path?: unknown
}

type CatalogSkill = {
  name: string
  path: string | undefined
}

function canonicalPath(path: string, cwd: string): string | undefined {
  try {
    return realpathSync(isAbsolute(path) ? path : resolve(cwd, path))
  } catch {
    return undefined
  }
}

export function skillNameForSuccessfulRead(
  result: ReadResult,
  skills: CatalogSkill[],
  cwd: string,
): string | undefined {
  if (
    result.toolName !== "read" ||
    result.isError ||
    typeof result.path !== "string"
  ) {
    return undefined
  }
  const readPath = canonicalPath(result.path, cwd)
  if (!readPath) return undefined
  return skills.find(
    (skill) =>
      typeof skill.path === "string" &&
      canonicalPath(skill.path, cwd) === readPath,
  )?.name
}
