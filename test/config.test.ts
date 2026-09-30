import { afterEach, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DEFAULT_SETTINGS, loadSettings, parseSettings } from "../src/config.ts"

const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true })
  }
})

test("the approved global Jev schema parses all adjustable limits", () => {
  expect(
    parseSettings({
      jev: {
        enabled: true,
        model: "jev-1.13.0",
        timeoutMs: 5_000,
        minRelevance: 0.85,
        maxRequestBytes: 65_536,
        maxSkills: 3,
        historyMessages: 6,
        historyChars: 12_000,
        excludedSkills: ["plan", "commit-push", "plan"],
      },
    }),
  ).toEqual({
    jev: {
      enabled: true,
      provider: "typesafe",
      model: "jev-1.13.0",
      timeoutMs: 5_000,
      minRelevance: 0.85,
      maxRequestBytes: 65_536,
      maxSkills: 3,
      historyMessages: 6,
      historyChars: 12_000,
      excludedSkills: ["plan", "commit-push"],
    },
  })
})

test.each([
  [undefined, "typesafe", "jev-1.13.0"],
  ["typesafe", "typesafe", "jev-1.13.0"],
  ["openrouter", "openrouter", "typesafe/jev-1.13"],
] as const)(
  "provider %s selects its default model",
  (configuredProvider, provider, model) => {
    expect(
      parseSettings({
        jev:
          configuredProvider === undefined
            ? {}
            : { provider: configuredProvider },
      }).jev,
    ).toMatchObject({ provider, model })
  },
)

test("an explicit model is preserved for either provider", () => {
  expect(
    parseSettings({ jev: { provider: "openrouter", model: "custom/model" } })
      .jev.model,
  ).toBe("custom/model")
})

test.each([[null], [false], [1], [{}], [[]], ["other"]] as const)(
  "invalid provider %p is rejected",
  (provider) => {
    expect(() => parseSettings({ jev: { provider } })).toThrow(
      "jev.provider is invalid",
    )
  },
)

test("missing config keeps network selection off", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-inline-config-"))
  directories.push(root)
  expect(loadSettings(join(root, "missing.json"))).toEqual({
    settings: DEFAULT_SETTINGS,
  })
})

test("invalid config reports a sanitized local error and fails closed", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-inline-config-"))
  directories.push(root)
  const path = join(root, "config.json")
  writeFileSync(path, JSON.stringify({ jev: { enabled: "yes" } }))

  const result = loadSettings(path)
  expect(result.settings.jev.enabled).toBe(false)
  expect(result.error).toBe("jev.enabled is invalid")
})
