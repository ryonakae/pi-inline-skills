import { existsSync, realpathSync } from "node:fs"
import { resolve } from "node:path"
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"

type AutocompleteItem = {
  value: string
  label: string
  description?: string
}

type AutocompleteSuggestions = {
  items: AutocompleteItem[]
  prefix: string
}

type AutocompleteProvider = {
  getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    options: { signal: AbortSignal; force?: boolean },
  ): Promise<AutocompleteSuggestions | null>
  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number }
  shouldTriggerFileCompletion?(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean
}

type SkillCommand = {
  name: string
  description?: string
  source: string
  sourceInfo: {
    path: string
  }
}

type SkillInfo = {
  name: string
  description?: string
}

type LoadedSkillEntryData = {
  name?: string
}

const LOADED_SKILL_ENTRY_TYPE = "loaded-skill"
const MAX_SUGGESTIONS = 30
const SKILL_TOKEN_RE = /(^|[\s([{,])\$([a-z0-9][a-z0-9-]{0,63})/gi
const DOLLAR_SKILL_CONTEXT_RE = /(?:^|[\s([{,])\$[a-z0-9-]*$/i

function fuzzyScore(value: string, query: string): number {
  const target = value.toLowerCase()
  const needle = query.toLowerCase()
  if (!needle) return 1
  if (target === needle) return 1000
  if (target.startsWith(needle)) return 800 - target.length
  if (target.includes(needle))
    return 600 - target.indexOf(needle) - target.length

  let score = 0
  let lastIndex = -1
  for (const char of needle) {
    const index = target.indexOf(char, lastIndex + 1)
    if (index === -1) return 0
    score += index === lastIndex + 1 ? 20 : 5
    lastIndex = index
  }
  return score - target.length
}

function filterSkills(skills: SkillInfo[], query: string): SkillInfo[] {
  return skills
    .map((skill) => ({ skill, score: fuzzyScore(skill.name, query) }))
    .filter((entry) => entry.score > 0)
    .toSorted(
      (a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name),
    )
    .map((entry) => entry.skill)
}

function getSkills(pi: ExtensionAPI): SkillInfo[] {
  return (pi.getCommands() as SkillCommand[])
    .filter(
      (command) =>
        command.source === "skill" && command.name.startsWith("skill:"),
    )
    .map((command) => {
      const skill: SkillInfo = { name: command.name.slice("skill:".length) }
      if (command.description) skill.description = command.description
      return skill
    })
}

function normalizePath(path: string, cwd: string): string {
  const absolutePath = path.startsWith("/") ? path : resolve(cwd, path)
  try {
    if (existsSync(absolutePath)) return realpathSync.native(absolutePath)
  } catch {
    // Fall back to the resolved path below.
  }
  return absolutePath
}

function getCurrentSkillPathMap(
  pi: ExtensionAPI,
  cwd: string,
): Map<string, string> {
  const skills = new Map<string, string>()

  for (const command of pi.getCommands() as SkillCommand[]) {
    if (command.source !== "skill") continue
    if (!command.name?.startsWith("skill:")) continue
    if (!command.sourceInfo?.path) continue

    skills.set(
      normalizePath(command.sourceInfo.path, cwd),
      command.name.slice("skill:".length),
    )
  }

  return skills
}

function restoreLoadedSkills(ctx: ExtensionContext): Set<string> {
  const loadedSkills = new Set<string>()

  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "custom") continue
    if (entry.customType !== LOADED_SKILL_ENTRY_TYPE) continue

    const data = entry.data as LoadedSkillEntryData | undefined
    if (typeof data?.name === "string" && data.name.trim()) {
      loadedSkills.add(data.name)
    }
  }

  return loadedSkills
}

function buildSkillLoadInstruction(skills: SkillInfo[]): string {
  const names = skills.map((skill) => skill.name).join(", ")
  return `Load ${names} ${skills.length === 1 ? "skill" : "skills"}.`
}

function expandInlineSkills(
  text: string,
  skills: SkillInfo[],
): { text: string; instruction: string } | undefined {
  const byName = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill]),
  )
  const selected: SkillInfo[] = []
  const seen = new Set<string>()

  let rewritten = text.replace(
    SKILL_TOKEN_RE,
    (match, boundary: string, skillName: string) => {
      const skill = byName.get(skillName.toLowerCase())
      if (!skill) return match
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        selected.push(skill)
      }
      return `${boundary}\`${skill.name}\``
    },
  )

  if (selected.length === 0) return undefined

  rewritten = rewritten.replace(/[ \t]{2,}/g, " ").trim()
  const instruction = buildSkillLoadInstruction(selected)
  return { text: rewritten || text, instruction }
}

function extractDollarSkillPrefix(
  textBeforeCursor: string,
): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{,])\$([a-z0-9-]*)$/i)
  return match?.[1]
}

function installDollarAutocompleteTrigger(): void {
  const proto = CustomEditor.prototype as unknown as {
    handleInput(data: string): void
    inlineSkillsDollarTriggerInstalled?: boolean
  }
  if (proto.inlineSkillsDollarTriggerInstalled) return

  const originalHandleInput = proto.handleInput
  proto.handleInput = function patchedHandleInput(
    this: unknown,
    data: string,
  ): void {
    originalHandleInput.call(this, data)

    const editor = this as {
      isShowingAutocomplete?: () => boolean
      getText?: () => string
      state?: { cursorLine: number; cursorCol: number; lines: string[] }
      tryTriggerAutocomplete?: () => void
    }
    if (
      editor.isShowingAutocomplete?.() ||
      !editor.state ||
      typeof editor.tryTriggerAutocomplete !== "function"
    )
      return
    if (!/^[a-zA-Z0-9\-_$]$/.test(data)) return

    const currentLine = editor.state.lines[editor.state.cursorLine] ?? ""
    const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol)
    if (DOLLAR_SKILL_CONTEXT_RE.test(textBeforeCursor)) {
      editor.tryTriggerAutocomplete()
    }
  }
  proto.inlineSkillsDollarTriggerInstalled = true
}

function createDollarSkillAutocompleteProvider(
  pi: ExtensionAPI,
  current: AutocompleteProvider,
): AutocompleteProvider {
  return {
    async getSuggestions(
      lines,
      cursorLine,
      cursorCol,
      options,
    ): Promise<AutocompleteSuggestions | null> {
      const currentLine = lines[cursorLine] ?? ""
      const textBeforeCursor = currentLine.slice(0, cursorCol)
      const query = extractDollarSkillPrefix(textBeforeCursor)
      if (query === undefined) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }

      const skills = getSkills(pi)
      if (options.signal.aborted || skills.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }

      const matches = query
        ? filterSkills(skills, query).slice(0, MAX_SUGGESTIONS)
        : skills.slice(0, MAX_SUGGESTIONS)

      if (matches.length === 0) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }

      return {
        prefix: `$${query}`,
        items: matches.map((skill): AutocompleteItem => {
          const item: AutocompleteItem = {
            value: `$${skill.name}`,
            label: skill.name,
          }
          if (skill.description) item.description = skill.description
          return item
        }),
      }
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      if (!prefix.startsWith("$")) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        )
      }

      const currentLine = lines[cursorLine] ?? ""
      const beforePrefix = currentLine.slice(0, cursorCol - prefix.length)
      const afterCursor = currentLine.slice(cursorCol)
      const suffix = afterCursor.startsWith(" ") ? "" : " "
      const nextLines = [...lines]
      nextLines[cursorLine] =
        `${beforePrefix}${item.value}${suffix}${afterCursor}`
      return {
        lines: nextLines,
        cursorLine,
        cursorCol: beforePrefix.length + item.value.length + suffix.length,
      }
    },

    shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
      return (
        current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
        true
      )
    },
  }
}

export default function (pi: ExtensionAPI): void {
  let pendingSkillLoadInstruction: string | undefined
  let loadedSkills = new Set<string>()

  installDollarAutocompleteTrigger()

  pi.registerCommand("loaded-skills", {
    description: "List skills loaded in this session",
    handler: async (_args, ctx) => {
      const names = [...restoreLoadedSkills(ctx)]
      if (names.length === 0) {
        ctx.ui.notify("No skills loaded yet", "info")
        return
      }
      ctx.ui.notify(`Loaded skills: ${names.join(", ")}`, "info")
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    loadedSkills = restoreLoadedSkills(ctx)
    ctx.ui.addAutocompleteProvider((current) =>
      createDollarSkillAutocompleteProvider(pi, current),
    )
  })

  pi.on("session_tree", async (_event, ctx) => {
    loadedSkills = restoreLoadedSkills(ctx)
  })

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName !== "read" || event.isError) return

    const input = event.input as { path?: unknown }
    if (typeof input.path !== "string") return

    const readPath = normalizePath(input.path, ctx.cwd)
    const skillName = getCurrentSkillPathMap(pi, ctx.cwd).get(readPath)
    if (!skillName || loadedSkills.has(skillName)) return

    loadedSkills.add(skillName)
    pi.appendEntry(LOADED_SKILL_ENTRY_TYPE, { name: skillName })
  })

  pi.on("input", async (event, ctx) => {
    pendingSkillLoadInstruction = undefined
    if (event.source === "extension" || !event.text.includes("$")) {
      return { action: "continue" }
    }

    try {
      const expanded = expandInlineSkills(event.text, getSkills(pi))
      if (!expanded) return { action: "continue" }
      pendingSkillLoadInstruction = expanded.instruction
      return {
        action: "transform",
        text: expanded.text,
        ...(event.images ? { images: event.images } : {}),
      }
    } catch (error) {
      ctx.ui.notify(
        `inline-skills: failed to expand skill: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      )
      return { action: "continue" }
    }
  })

  pi.on("before_agent_start", async (event) => {
    if (!pendingSkillLoadInstruction) return
    const instruction = pendingSkillLoadInstruction
    pendingSkillLoadInstruction = undefined
    return {
      systemPrompt: `${event.systemPrompt}\n\n${instruction}`,
    }
  })
}
