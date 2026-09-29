import { parseSkillBlock } from "@earendil-works/pi-coding-agent"

type SessionEntry = {
  type?: unknown
  customType?: unknown
  data?: { name?: unknown; source?: unknown }
  details?: {
    names?: unknown
    skills?: unknown
  }
  message?: {
    role?: unknown
    content?: unknown
  }
}

function userMessageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n")
}

function addNames(value: unknown, loaded: Set<string>): void {
  if (!Array.isArray(value)) return
  for (const name of value) {
    if (typeof name === "string" && name.trim()) loaded.add(name)
  }
}

export function nativeSkillNames(text: string): string[] {
  return [
    ...text.matchAll(
      /<skill name="[^"]+" location="[^"]+">\n[\s\S]*?\n<\/skill>/gu,
    ),
  ].flatMap(([block]) => {
    const parsed = parseSkillBlock(block)
    return parsed?.name.trim() ? [parsed.name] : []
  })
}

export function restoreLoadedSkillNames(entries: unknown[]): Set<string> {
  const loaded = new Set<string>()

  for (const rawEntry of entries) {
    if (typeof rawEntry !== "object" || rawEntry === null) continue
    const entry = rawEntry as SessionEntry
    if (entry.type === "message" && entry.message?.role === "user") {
      for (const name of nativeSkillNames(
        userMessageText(entry.message.content),
      ))
        loaded.add(name)
      continue
    }

    if (
      entry.type === "custom" &&
      entry.customType === "loaded-skill" &&
      entry.data?.source === "tool-result" &&
      typeof entry.data.name === "string" &&
      entry.data.name.trim()
    ) {
      loaded.add(entry.data.name)
      continue
    }

    if (
      entry.type === "custom_message" &&
      entry.customType === "inline-skill"
    ) {
      addNames(entry.details?.names, loaded)
      if (Array.isArray(entry.details?.skills)) {
        addNames(
          entry.details.skills.map((skill) =>
            typeof skill === "object" && skill !== null && "name" in skill
              ? skill.name
              : undefined,
          ),
          loaded,
        )
      }
    }
  }

  return loaded
}
