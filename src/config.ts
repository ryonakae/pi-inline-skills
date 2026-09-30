import { readFileSync } from "node:fs"
import { join } from "node:path"
import { getAgentDir } from "@earendil-works/pi-coding-agent"

export type JevProvider = "typesafe" | "openrouter"

export type JevSettings = {
  enabled: boolean
  provider: JevProvider
  model: string
  timeoutMs: number
  minRelevance: number
  maxRequestBytes: number
  maxSkills: number
  historyMessages: number
  historyChars: number
  excludedSkills: string[]
}

export type InlineSkillsSettings = {
  jev: JevSettings
}

export type SettingsResult = {
  settings: InlineSkillsSettings
  error?: string
}

export const DEFAULT_SETTINGS: InlineSkillsSettings = Object.freeze({
  jev: Object.freeze({
    enabled: false,
    provider: "typesafe",
    model: "jev-1.13.0",
    timeoutMs: 5_000,
    minRelevance: 0.85,
    maxRequestBytes: 65_536,
    maxSkills: 3,
    historyMessages: 6,
    historyChars: 12_000,
    excludedSkills: Object.freeze([]) as unknown as string[],
  }),
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberSetting(
  value: unknown,
  fallback: number,
  name: string,
  options: { integer?: boolean; min: number; max?: number },
): number {
  if (value === undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (options.integer === true && !Number.isInteger(value)) ||
    value < options.min ||
    (options.max !== undefined && value > options.max)
  ) {
    throw new Error(`jev.${name} is invalid`)
  }
  return value
}

export function parseSettings(value: unknown): InlineSkillsSettings {
  if (!isRecord(value)) throw new Error("configuration must be an object")
  const rawJev = value["jev"]
  if (rawJev === undefined) return structuredClone(DEFAULT_SETTINGS)
  if (!isRecord(rawJev)) throw new Error("jev must be an object")

  const enabled = rawJev["enabled"] ?? DEFAULT_SETTINGS.jev.enabled
  if (typeof enabled !== "boolean") throw new Error("jev.enabled is invalid")
  const provider =
    rawJev["provider"] === undefined
      ? DEFAULT_SETTINGS.jev.provider
      : rawJev["provider"]
  if (provider !== "typesafe" && provider !== "openrouter") {
    throw new Error("jev.provider is invalid")
  }
  const model =
    rawJev["model"] ??
    (provider === "openrouter" ? "typesafe/jev-1.13" : "jev-1.13.0")
  if (typeof model !== "string" || model.trim().length === 0) {
    throw new Error("jev.model is invalid")
  }
  const excludedSkills =
    rawJev["excludedSkills"] ?? DEFAULT_SETTINGS.jev.excludedSkills
  if (
    !Array.isArray(excludedSkills) ||
    !excludedSkills.every(
      (name) => typeof name === "string" && name.trim().length > 0,
    )
  ) {
    throw new Error("jev.excludedSkills is invalid")
  }

  return {
    jev: {
      enabled,
      provider,
      model,
      timeoutMs: numberSetting(
        rawJev["timeoutMs"],
        DEFAULT_SETTINGS.jev.timeoutMs,
        "timeoutMs",
        { integer: true, min: 1 },
      ),
      minRelevance: numberSetting(
        rawJev["minRelevance"],
        DEFAULT_SETTINGS.jev.minRelevance,
        "minRelevance",
        { min: 0, max: 1 },
      ),
      maxRequestBytes: numberSetting(
        rawJev["maxRequestBytes"],
        DEFAULT_SETTINGS.jev.maxRequestBytes,
        "maxRequestBytes",
        { integer: true, min: 1 },
      ),
      maxSkills: numberSetting(
        rawJev["maxSkills"],
        DEFAULT_SETTINGS.jev.maxSkills,
        "maxSkills",
        { integer: true, min: 0 },
      ),
      historyMessages: numberSetting(
        rawJev["historyMessages"],
        DEFAULT_SETTINGS.jev.historyMessages,
        "historyMessages",
        { integer: true, min: 1 },
      ),
      historyChars: numberSetting(
        rawJev["historyChars"],
        DEFAULT_SETTINGS.jev.historyChars,
        "historyChars",
        { integer: true, min: 1 },
      ),
      excludedSkills: [...new Set(excludedSkills)],
    },
  }
}

export function loadSettings(
  configPath = join(
    getAgentDir(),
    "extensions",
    "pi-inline-skills",
    "config.json",
  ),
): SettingsResult {
  try {
    return {
      settings: parseSettings(JSON.parse(readFileSync(configPath, "utf-8"))),
    }
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : undefined
    if (code === "ENOENT")
      return { settings: structuredClone(DEFAULT_SETTINGS) }
    return {
      settings: structuredClone(DEFAULT_SETTINGS),
      error: error instanceof Error ? error.message : "invalid configuration",
    }
  }
}
