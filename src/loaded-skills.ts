import { parseSkillBlock } from "@earendil-works/pi-coding-agent"
import { skillNameForSuccessfulRead } from "./read-tracking.ts"

type SessionEntry = {
  type?: unknown
  customType?: unknown
  data?: unknown
  details?: unknown
  message?: {
    role?: unknown
    content?: unknown
    toolCallId?: unknown
    toolName?: unknown
    isError?: unknown
  }
}

type ProjectedMessage = {
  role?: unknown
  customType?: unknown
  content?: unknown
  toolCallId?: unknown
  toolName?: unknown
  isError?: unknown
}

type SessionProjection = {
  entries: Array<{
    sourceEntry: SessionEntry
    messages: ProjectedMessage[]
  }>
}

type CatalogSkill = {
  name: string
  path: string | undefined
}

function objectValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined
}

function messageText(content: unknown): string {
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
      for (const name of nativeSkillNames(messageText(entry.message.content)))
        loaded.add(name)
      continue
    }

    const data = objectValue(entry.data)
    if (
      entry.type === "custom" &&
      entry.customType === "loaded-skill" &&
      data?.["source"] === "tool-result" &&
      typeof data["name"] === "string" &&
      data["name"].trim()
    ) {
      loaded.add(data["name"])
      continue
    }

    if (
      entry.type === "custom_message" &&
      entry.customType === "inline-skill"
    ) {
      const details = objectValue(entry.details)
      addNames(details?.["names"], loaded)
      if (Array.isArray(details?.["skills"])) {
        addNames(
          details["skills"].map((skill) =>
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

function readToolCalls(messages: ProjectedMessage[]): Map<string, unknown> {
  const calls = new Map<string, unknown>()
  for (const message of messages) {
    if (message.role !== "assistant" || !Array.isArray(message.content))
      continue
    for (const block of message.content) {
      if (
        typeof block !== "object" ||
        block === null ||
        (block as { type?: unknown }).type !== "toolCall" ||
        (block as { name?: unknown }).name !== "read" ||
        typeof (block as { id?: unknown }).id !== "string"
      )
        continue
      const argumentsValue = (block as { arguments?: unknown }).arguments
      const path =
        typeof argumentsValue === "object" && argumentsValue !== null
          ? (argumentsValue as { path?: unknown }).path
          : undefined
      calls.set((block as { id: string }).id, path)
    }
  }
  return calls
}

export function effectiveLoadedSkillNames(
  projection: SessionProjection,
  skills: CatalogSkill[],
  cwd: string,
  branch: SessionEntry[] = [],
): Set<string> {
  const loaded = new Set<string>()
  const projectedMessages = projection.entries.flatMap(
    (entry) => entry.messages,
  )
  const readCalls = readToolCalls([
    ...branch.flatMap((entry) =>
      entry.type === "message" && entry.message ? [entry.message] : [],
    ),
    ...projectedMessages,
  ])
  const recordedReads = new Map<string, string>()

  for (const { sourceEntry } of projection.entries) {
    const data = objectValue(sourceEntry.data)
    if (
      sourceEntry.type === "custom" &&
      sourceEntry.customType === "loaded-skill" &&
      data?.["source"] === "tool-result" &&
      typeof data["name"] === "string" &&
      typeof data["toolCallId"] === "string"
    ) {
      recordedReads.set(data["toolCallId"], data["name"])
    }
  }

  for (const entry of projection.entries) {
    const source = entry.sourceEntry
    if (
      source.type === "custom_message" &&
      source.customType === "inline-skill"
    ) {
      for (const message of entry.messages) {
        if (message.role !== "custom") continue
        for (const name of nativeSkillNames(messageText(message.content)))
          loaded.add(name)
      }
      continue
    }

    if (source.type === "message" && source.message?.role === "user") {
      for (const message of entry.messages) {
        if (message.role !== "user") continue
        for (const name of nativeSkillNames(messageText(message.content)))
          loaded.add(name)
      }
      continue
    }

    if (
      source.type !== "message" ||
      source.message?.role !== "toolResult" ||
      source.message.toolName !== "read" ||
      source.message.isError !== false ||
      typeof source.message.toolCallId !== "string"
    )
      continue
    const result = entry.messages.find(
      (message) =>
        message.role === "toolResult" &&
        message.toolName === "read" &&
        message.isError === false &&
        message.toolCallId === source.message?.toolCallId,
    )
    if (
      !result ||
      JSON.stringify(result.content) !== JSON.stringify(source.message.content)
    )
      continue

    const toolCallId = source.message.toolCallId
    const path = readCalls.get(toolCallId)
    const name =
      path !== undefined
        ? skillNameForSuccessfulRead(
            { toolName: "read", isError: false, path },
            skills,
            cwd,
          )
        : recordedReads.get(toolCallId)
    if (name) loaded.add(name)
  }

  return loaded
}
