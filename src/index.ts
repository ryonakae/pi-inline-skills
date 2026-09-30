import { existsSync, readFileSync, realpathSync } from "node:fs"
import { dirname, resolve } from "node:path"
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  SkillInvocationMessageComponent,
  type ParsedSkillBlock,
} from "@earendil-works/pi-coding-agent"
import { Box, Container, Text } from "@earendil-works/pi-tui"
import { captureChildContext } from "./child-context.ts"
import { loadSettings } from "./config.ts"
import {
  buildConversationState,
  skillRequestText,
  textContent,
} from "./conversation.ts"
import { consumedInputBatch } from "./input-batch.ts"
import { JevSelectionError, selectSkills } from "./jev-client.ts"
import { isAutomaticSkillCandidate } from "./skill-catalog.ts"
import {
  effectiveLoadedSkillNames,
  nativeSkillNames,
  restoreLoadedSkillNames,
} from "./loaded-skills.ts"
import { skillNameForSuccessfulRead } from "./read-tracking.ts"

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
    source: string
    scope: "user" | "project" | "temporary"
  }
}

type SkillInfo = {
  name: string
  description?: string
  sourceInfo?: SkillCommand["sourceInfo"]
}

type InlineSkillMessageDetails = {
  names?: string[]
  skills?: ParsedSkillBlock[]
  source?: "manual" | "jev"
}

type SkillInjection = {
  content: string
  names: string[]
  skills: ParsedSkillBlock[]
}

const LOADED_SKILL_ENTRY_TYPE = "loaded-skill"
const INLINE_SKILL_MESSAGE_TYPE = "inline-skill"
const MAX_SUGGESTIONS = 30
const SKILL_TOKEN_RE =
  /(^|[\s([{,])\/([a-z0-9][a-z0-9-]{0,63})(?![a-z0-9-]|[:/])/gi
const SLASH_SKILL_CONTEXT_RE = /(?:^|[\s([{,])\/[a-z0-9-]*$/i

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

function getAutocompleteSourceTag(
  sourceInfo: SkillCommand["sourceInfo"] | undefined,
): string | undefined {
  if (!sourceInfo) return undefined

  const scopePrefix =
    sourceInfo.scope === "user"
      ? "u"
      : sourceInfo.scope === "project"
        ? "p"
        : "t"
  const source = sourceInfo.source.trim()
  if (source === "auto" || source === "local" || source === "cli") {
    return scopePrefix
  }
  if (source.startsWith("npm:")) return `${scopePrefix}:${source}`
  return scopePrefix
}

function prefixAutocompleteDescription(skill: SkillInfo): string | undefined {
  const sourceTag = getAutocompleteSourceTag(skill.sourceInfo)
  if (!sourceTag) return skill.description
  return skill.description
    ? `[${sourceTag}] ${skill.description}`
    : `[${sourceTag}]`
}

function getSkills(pi: ExtensionAPI): SkillInfo[] {
  return (pi.getCommands() as SkillCommand[])
    .filter(
      (command) =>
        command.source === "skill" && command.name.startsWith("skill:"),
    )
    .map((command) => {
      const skill: SkillInfo = {
        name: command.name.slice("skill:".length),
        sourceInfo: command.sourceInfo,
      }
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

function restoreLoadedSkills(ctx: ExtensionContext): Set<string> {
  return restoreLoadedSkillNames(ctx.sessionManager.getBranch())
}

function effectiveLoadedSkills(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): Set<string> {
  return effectiveLoadedSkillNames(
    ctx.sessionManager.buildSessionProjection(),
    getSkills(pi).map((skill) => ({
      name: skill.name,
      path: skill.sourceInfo?.path,
    })),
    ctx.cwd,
    ctx.sessionManager.getBranch(),
  )
}

function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content

  const end = content.indexOf("\n---", 3)
  if (end === -1) return content

  const afterEnd = content.indexOf("\n", end + 4)
  return afterEnd === -1 ? "" : content.slice(afterEnd + 1)
}

function escapeXmlAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

function buildSkillBlock(
  skill: SkillInfo,
  cwd: string,
): { text: string; skillBlock: ParsedSkillBlock } {
  const skillPath = skill.sourceInfo?.path
  if (!skillPath) {
    throw new Error(`missing path for skill ${skill.name}`)
  }

  const normalizedPath = normalizePath(skillPath, cwd)
  const content = readFileSync(normalizedPath, "utf-8")
  const body = stripFrontmatter(content).trim()
  const skillContent = `References are relative to ${dirname(normalizedPath)}.\n\n${body}`
  return {
    text: `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(normalizedPath)}">\n${skillContent}\n</skill>`,
    skillBlock: {
      name: skill.name,
      location: normalizedPath,
      content: skillContent,
      userMessage: undefined,
    },
  }
}

function renderSkillInjection(skills: ParsedSkillBlock[]): SkillInjection {
  const blocks = skills
    .map(
      (skill) =>
        `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.location)}">\n${skill.content}\n</skill>`,
    )
    .join("\n\n")
  return {
    content: `<inline_skills>\nThe following inline skill contents are already loaded. Do not load them again unless the user asks to inspect the source file.\n\n${blocks}\n</inline_skills>`,
    names: skills.map((skill) => skill.name),
    skills,
  }
}

function buildSkillInjection(
  skills: SkillInfo[],
  cwd: string,
  onError: (skill: SkillInfo, error: unknown) => void,
): SkillInjection | undefined {
  const built = skills.flatMap((skill) => {
    try {
      return [buildSkillBlock(skill, cwd)]
    } catch (error) {
      onError(skill, error)
      return []
    }
  })
  if (built.length === 0) return undefined

  return renderSkillInjection(built.map((skill) => skill.skillBlock))
}

function findInlineSkills(
  text: string,
  skills: SkillInfo[],
): { selected: SkillInfo[] } | undefined {
  const byName = new Map(
    skills.map((skill) => [skill.name.toLowerCase(), skill]),
  )
  const selected: SkillInfo[] = []
  const seen = new Set<string>()

  text.replace(
    SKILL_TOKEN_RE,
    (match, _boundary: string, skillName: string) => {
      const skill = byName.get(skillName.toLowerCase())
      if (!skill) return match
      if (!seen.has(skill.name)) {
        seen.add(skill.name)
        selected.push(skill)
      }
      return match
    },
  )

  if (selected.length === 0) return undefined

  return { selected }
}

function extractSlashSkillPrefix(textBeforeCursor: string): string | undefined {
  const match = textBeforeCursor.match(/(?:^|[\s([{,])\/([a-z0-9-]*)$/i)
  return match?.[1]
}

function isPromptStartSlashToken(
  lines: string[],
  cursorLine: number,
  textBeforeCursor: string,
  prefix: string,
): boolean {
  const slashPrefixStart = textBeforeCursor.length - prefix.length - 1
  if (slashPrefixStart < 0) return false
  const earlierLinesAreBlank = lines
    .slice(0, cursorLine)
    .every((line) => line.trim().length === 0)
  return (
    earlierLinesAreBlank &&
    textBeforeCursor.slice(0, slashPrefixStart).trim() === ""
  )
}

function mergeAutocompleteItems(options: {
  current: AutocompleteSuggestions | null
  skillItems: AutocompleteItem[]
  preferCommands: boolean
  prefix: string
}): AutocompleteSuggestions {
  const currentItems = options.current?.items ?? []
  const orderedItems = options.preferCommands
    ? [...currentItems, ...options.skillItems]
    : [...options.skillItems, ...currentItems]
  const seen = new Set<string>()
  const items = orderedItems.filter((item) => {
    const key = `${item.label}\u0000${item.value}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return {
    prefix: options.prefix,
    items: items.slice(0, MAX_SUGGESTIONS),
  }
}

function installSlashAutocompleteTrigger(): void {
  const proto = CustomEditor.prototype as unknown as {
    handleInput(data: string): void
    inlineSkillsSlashTriggerInstalled?: boolean
  }
  if (proto.inlineSkillsSlashTriggerInstalled) return

  const originalHandleInput = proto.handleInput
  proto.handleInput = function patchedHandleInput(
    this: unknown,
    data: string,
  ): void {
    const editor = this as {
      isShowingAutocomplete?: () => boolean
      state?: { cursorLine: number; cursorCol: number; lines: string[] }
      tryTriggerAutocomplete?: () => void
    }

    originalHandleInput.call(this, data)
    if (
      editor.isShowingAutocomplete?.() ||
      !editor.state ||
      typeof editor.tryTriggerAutocomplete !== "function"
    )
      return
    if (!/^[a-zA-Z0-9\-_/]$/.test(data)) return

    const currentLine = editor.state.lines[editor.state.cursorLine] ?? ""
    const textBeforeCursor = currentLine.slice(0, editor.state.cursorCol)
    if (SLASH_SKILL_CONTEXT_RE.test(textBeforeCursor)) {
      editor.tryTriggerAutocomplete()
    }
  }
  proto.inlineSkillsSlashTriggerInstalled = true
}

function createSlashSkillAutocompleteProvider(
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
      const query = extractSlashSkillPrefix(textBeforeCursor)
      if (query === undefined || (query === "" && textBeforeCursor === "/")) {
        return current.getSuggestions(lines, cursorLine, cursorCol, options)
      }

      const currentSuggestions = await current.getSuggestions(
        lines,
        cursorLine,
        cursorCol,
        options,
      )
      const skills = getSkills(pi)
      if (options.signal.aborted || skills.length === 0) {
        return currentSuggestions
      }

      const matches = query
        ? filterSkills(skills, query).slice(0, MAX_SUGGESTIONS)
        : skills.slice(0, MAX_SUGGESTIONS)

      if (matches.length === 0) return currentSuggestions

      const skillItems = matches.map((skill): AutocompleteItem => {
        const item: AutocompleteItem = {
          value: `/${skill.name}`,
          label: `skill:${skill.name}`,
        }
        const description = prefixAutocompleteDescription(skill)
        if (description) item.description = description
        return item
      })

      return mergeAutocompleteItems({
        current: currentSuggestions,
        skillItems,
        preferCommands: isPromptStartSlashToken(
          lines,
          cursorLine,
          textBeforeCursor,
          query,
        ),
        prefix: query,
      })
    },

    applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
      const currentLine = lines[cursorLine] ?? ""
      const slashPrefixStart = cursorCol - prefix.length - 1
      const isSlashSkillCompletion =
        item.label.startsWith("skill:") &&
        item.value.startsWith("/") &&
        slashPrefixStart >= 0 &&
        currentLine[slashPrefixStart] === "/"

      if (!isSlashSkillCompletion) {
        return current.applyCompletion(
          lines,
          cursorLine,
          cursorCol,
          item,
          prefix,
        )
      }

      const beforePrefix = currentLine.slice(0, slashPrefixStart)
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
  const settingsResult = loadSettings()
  const settings = settingsResult.settings
  const childContext = captureChildContext()
  const automaticSelectionEnabled =
    settings.jev.enabled &&
    childContext.supported &&
    !childContext.isChildSession
  const manualPersistenceScheduled = new Set<string>()
  const automaticPersistenceScheduled = new Set<string>()
  const decisions = new Map<string, Promise<SkillInjection | undefined>>()
  const pendingSuccessfulReads = new Map<
    string,
    { name: string; toolCallId: string }
  >()
  const completedBatches = new Set<string>()
  let generation = 0
  let activeBatch: string | undefined

  const invalidateRecommendations = (): void => {
    generation += 1
    activeBatch = undefined
  }
  const clearPending = (): void => {
    invalidateRecommendations()
    manualPersistenceScheduled.clear()
    automaticPersistenceScheduled.clear()
    pendingSuccessfulReads.clear()
    decisions.clear()
    completedBatches.clear()
  }

  const explicitSkills = (text: string): SkillInfo[] => {
    const request = skillRequestText(text)
    return findInlineSkills(request, getSkills(pi))?.selected ?? []
  }
  const manualInjection = (
    texts: string[],
    ctx: ExtensionContext,
    loadedSkills: Set<string>,
  ): SkillInjection | undefined => {
    const selected = texts
      .flatMap(explicitSkills)
      .filter(
        (skill, index, skills) =>
          !loadedSkills.has(skill.name) &&
          skills.findIndex((other) => other.name === skill.name) === index,
      )
    return buildSkillInjection(selected, ctx.cwd, (skill) =>
      ctx.ui.notify(`inline-skills: failed to load ${skill.name}`, "error"),
    )
  }

  installSlashAutocompleteTrigger()

  pi.registerMessageRenderer(
    INLINE_SKILL_MESSAGE_TYPE,
    (message, { expanded }, theme) => {
      const details = message.details as InlineSkillMessageDetails | undefined
      const names = details?.names?.length ? details.names.join(", ") : "skill"
      const label = theme.fg(
        "customMessageLabel",
        `\x1b[1m[${INLINE_SKILL_MESSAGE_TYPE}]\x1b[22m`,
      )

      if (details?.skills?.length) {
        const container = new Container()
        for (const skill of details.skills) {
          const component = new SkillInvocationMessageComponent(skill)
          component.setExpanded(expanded)
          container.addChild(component)
        }
        return container
      }

      const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
      box.addChild(
        new Text(
          `${label} ${theme.fg("customMessageText", names)}${theme.fg("dim", " (ctrl+o to expand)")}`,
          0,
          0,
        ),
      )
      return box
    },
  )

  pi.registerCommand("loaded-skills", {
    description: "List skills loaded in this session",
    handler: async (_args, ctx) => {
      const names = [...restoreLoadedSkills(ctx)].toSorted((a, b) =>
        a.localeCompare(b),
      )

      if (names.length === 0) {
        ctx.ui.notify("No skills loaded yet", "info")
        return
      }
      ctx.ui.notify(`Loaded skills: ${names.join(", ")}`, "info")
    },
  })

  pi.on("session_start", async (_event, ctx) => {
    clearPending()
    if (settingsResult.error) {
      ctx.ui.notify(
        `inline-skills: invalid config; Jev selection disabled (${settingsResult.error})`,
        "warning",
      )
    } else if (settings.jev.enabled && !childContext.supported) {
      ctx.ui.notify(
        `inline-skills: pi-subagents child context ${childContext.reason}; Jev selection disabled`,
        "warning",
      )
    }
    ctx.ui.addAutocompleteProvider((current) =>
      createSlashSkillAutocompleteProvider(pi, current),
    )
  })

  pi.on("session_tree", async () => {
    clearPending()
  })

  pi.on("session_before_switch", () => {
    clearPending()
  })

  pi.on("session_before_fork", () => {
    clearPending()
  })

  pi.on("session_shutdown", () => {
    clearPending()
  })

  pi.on("tool_result", async (event, ctx) => {
    const skillName = skillNameForSuccessfulRead(
      {
        toolName: event.toolName,
        isError: event.isError,
        path: event.input["path"],
      },
      getSkills(pi).map((skill) => ({
        name: skill.name,
        path: skill.sourceInfo?.path,
      })),
      ctx.cwd,
    )
    if (!skillName) return

    pendingSuccessfulReads.set(event.toolCallId, {
      name: skillName,
      toolCallId: event.toolCallId,
    })
  })

  pi.on("turn_end", (event) => {
    for (const result of event.toolResults) {
      const read = pendingSuccessfulReads.get(result.toolCallId)
      if (!read || result.toolName !== "read" || result.isError) continue
      pi.appendEntry(LOADED_SKILL_ENTRY_TYPE, {
        name: read.name,
        source: "tool-result",
        toolCallId: read.toolCallId,
      })
      pendingSuccessfulReads.delete(result.toolCallId)
    }
  })

  pi.on("agent_end", (event) => {
    const lastAssistant = event.messages.findLast(
      (message) => message.role === "assistant",
    )
    // Error runs may retry before pre-settlement; keep their decision available until then.
    if (activeBatch && lastAssistant?.stopReason !== "error")
      completedBatches.add(activeBatch)
    invalidateRecommendations()
  })
  pi.on("agent_before_settle", () => {
    for (const key of decisions.keys()) completedBatches.add(key)
  })
  pi.on("agent_settled", () => {
    clearPending()
  })

  pi.on("context", async (event, ctx) => {
    const batch = consumedInputBatch(ctx)
    if (!batch || ctx.isIdle() || ctx.signal?.aborted) return
    if (activeBatch !== batch.key) {
      invalidateRecommendations()
      activeBatch = batch.key
    }
    const requestGeneration = generation
    const signal = ctx.signal
    const valid = (): boolean =>
      !signal?.aborted &&
      generation === requestGeneration &&
      !ctx.isIdle() &&
      activeBatch === batch.key &&
      consumedInputBatch(ctx)?.key === batch.key
    const loadedSkills = effectiveLoadedSkills(pi, ctx)
    const texts = batch.users.map(({ message }) => textContent(message))
    const injection = manualInjection(texts, ctx, loadedSkills)
    const messages = [...event.messages]
    if (injection) {
      const message = {
        customType: INLINE_SKILL_MESSAGE_TYPE,
        content: injection.content,
        display: true,
        details: {
          names: injection.names,
          skills: injection.skills,
          source: "manual" as const,
        },
      }
      // Persistence is delayed by Pi until turn end; retry still needs request-local content.
      if (!manualPersistenceScheduled.has(batch.key)) {
        manualPersistenceScheduled.add(batch.key)
        pi.sendMessage(message, { triggerTurn: false })
      }
      messages.push({ ...message, role: "custom", timestamp: Date.now() })
      for (const name of injection.names) loadedSkills.add(name)
    }

    const conversation = buildConversationState(batch.history, texts, {
      maxMessages: settings.jev.historyMessages,
      maxChars: settings.jev.historyChars,
    })
    const currentInput = conversation.currentInput
    if (
      !automaticSelectionEnabled ||
      !currentInput ||
      settings.jev.maxSkills === 0 ||
      completedBatches.has(batch.key)
    )
      return { messages }
    if (!decisions.has(batch.key)) {
      const explicitNames = [
        ...new Set(
          texts.flatMap((text) =>
            explicitSkills(text)
              .map((skill) => skill.name)
              .concat(nativeSkillNames(text)),
          ),
        ),
      ]
      const excluded = new Set(settings.jev.excludedSkills)
      const candidates = getSkills(pi).filter(
        (skill) =>
          !loadedSkills.has(skill.name) &&
          !explicitNames.includes(skill.name) &&
          isAutomaticSkillCandidate(
            { name: skill.name, path: skill.sourceInfo?.path },
            excluded,
          ),
      )
      decisions.set(
        batch.key,
        (async (): Promise<SkillInjection | undefined> => {
          if (candidates.length === 0) return undefined
          try {
            const apiKey =
              settings.jev.provider === "openrouter"
                ? await ctx.modelRegistry.getApiKeyForProvider("openrouter")
                : process.env["TYPESAFE_API_KEY"]
            if (!valid()) return undefined
            if (!apiKey) {
              ctx.ui.notify(
                `inline-skills: Jev selection skipped (${settings.jev.provider} credentials unavailable)`,
                "warning",
              )
              return undefined
            }
            const selection = await selectSkills({
              settings: settings.jev,
              apiKey,
              currentInput,
              conversation: conversation.messages,
              conversationTruncated: conversation.truncated,
              candidates,
              explicitSkills: explicitNames,
              loadedSkills: [...loadedSkills],
              ...(signal ? { signal } : {}),
            })
            if (!valid()) return undefined
            const selected = selection.selected.flatMap((name) =>
              candidates.filter((skill) => skill.name === name),
            )
            const currentLoaded = effectiveLoadedSkills(pi, ctx)
            return buildSkillInjection(
              selected.filter((skill) => !currentLoaded.has(skill.name)),
              ctx.cwd,
              (skill) => {
                if (valid())
                  ctx.ui.notify(
                    `inline-skills: failed to load ${skill.name}`,
                    "error",
                  )
              },
            )
          } catch (error) {
            if (
              valid() &&
              (!(error instanceof JevSelectionError) ||
                error.kind !== "aborted")
            ) {
              ctx.ui.notify(
                `inline-skills: Jev selection skipped (${error instanceof JevSelectionError ? error.kind : "unknown"})`,
                "warning",
              )
            }
            return undefined
          }
        })(),
      )
    }
    const decision = await decisions.get(batch.key)!
    if (!valid() || !decision) return { messages }
    const currentLoaded = effectiveLoadedSkills(pi, ctx)
    const remaining = decision.skills.filter(
      (skill) => !currentLoaded.has(skill.name),
    )
    if (remaining.length === 0) return { messages }
    const automaticInjection = renderSkillInjection(remaining)
    const message = {
      customType: INLINE_SKILL_MESSAGE_TYPE,
      content: automaticInjection.content,
      display: false,
      details: {
        names: automaticInjection.names,
        skills: automaticInjection.skills,
        source: "jev" as const,
      },
    }
    if (!valid()) return { messages }
    if (!automaticPersistenceScheduled.has(batch.key)) {
      automaticPersistenceScheduled.add(batch.key)
      pi.sendMessage(message, { triggerTurn: false })
      ctx.ui.notify(
        `inline-skills: loaded ${automaticInjection.names.join(", ")} by Jev`,
        "info",
      )
    }
    messages.push({ ...message, role: "custom", timestamp: Date.now() })
    return { messages }
  })

  pi.on("before_agent_start", (event, ctx) => {
    const loadedSkills = effectiveLoadedSkills(pi, ctx)
    for (const name of nativeSkillNames(event.prompt)) loadedSkills.add(name)
    const injection = manualInjection([event.prompt], ctx, loadedSkills)
    if (!injection) return
    return {
      message: {
        customType: INLINE_SKILL_MESSAGE_TYPE,
        content: injection.content,
        display: true,
        details: {
          names: injection.names,
          skills: injection.skills,
          source: "manual",
        },
      },
    }
  })
}
