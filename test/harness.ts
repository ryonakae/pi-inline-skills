import { afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type PromptTemplate,
} from "@earendil-works/pi-coding-agent"
import { fauxProvider, type TranscriptContext } from "@earendil-works/pi-ai"
import inlineSkills from "../src/index.ts"

const symbol = Symbol.for("pi-subagents:child-context")
const globals = globalThis as Record<PropertyKey, unknown>
const original = {
  fetch: globalThis.fetch,
  dir: process.env["PI_CODING_AGENT_DIR"],
  typesafeKey: process.env["TYPESAFE_API_KEY"],
  openRouterKey: process.env["OPENROUTER_API_KEY"],
  accessor: globals[symbol],
}
const roots: string[] = []
afterEach(() => {
  globalThis.fetch = original.fetch
  for (const [key, value] of [
    ["PI_CODING_AGENT_DIR", original.dir],
    ["TYPESAFE_API_KEY", original.typesafeKey],
    ["OPENROUTER_API_KEY", original.openRouterKey],
  ] as const) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  if (original.accessor === undefined) delete globals[symbol]
  else globals[symbol] = original.accessor
  for (const root of roots.splice(0)) rmSync(root, { recursive: true })
})

export function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { promise, release }
}
export function waitFor(condition: () => boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    let attempts = 0
    const poll = (): void => {
      if (condition()) {
        resolve()
        return
      }
      if (++attempts >= 200) {
        reject(new Error("timed out waiting for faux provider"))
        return
      }
      setTimeout(poll, 5)
    }
    poll()
  })
}
export function text(message: unknown): string {
  if (
    typeof message !== "object" ||
    message === null ||
    !("content" in message)
  )
    return ""
  if (typeof message.content === "string") return message.content
  if (!Array.isArray(message.content)) return ""
  return message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n")
}
export function bodyCount(context: TranscriptContext, name: string): number {
  return context.messages.filter((message) =>
    text(message).includes(`${name.toUpperCase()}_SKILL_BODY`),
  ).length
}
export type Payload = {
  state: {
    currentInput: string
    conversation: Array<{ role: string; text: string }>
    explicitSkills: string[]
    loadedSkills: string[]
  }
  questions: Record<string, { instructions: string }>
}
export async function setup(options: {
  responses: Parameters<ReturnType<typeof fauxProvider>["setResponses"]>[0]
  jev?: boolean
  jevProvider?: "typesafe" | "openrouter"
  jevMaxSkills?: number
  resolveOpenRouterKey?: () => Promise<string | undefined>
  child?: boolean | "unknown"
  settings?: Parameters<typeof SettingsManager.inMemory>[0]
  extensions?: ExtensionFactory[]
  beforeExtensions?: ExtensionFactory[]
  fetch?: (payload: Payload, init?: RequestInit) => Promise<Response>
  skillBody?: Record<string, string>
  tools?: boolean
  templates?: PromptTemplate[]
}) {
  const root = mkdtempSync(join(tmpdir(), "inline-regression-"))
  roots.push(root)
  const agentDir = join(root, "agent")
  const cwd = join(root, "workspace")
  mkdirSync(cwd)
  mkdirSync(join(agentDir, "extensions", "pi-inline-skills"), {
    recursive: true,
  })
  writeFileSync(
    join(agentDir, "extensions", "pi-inline-skills", "config.json"),
    JSON.stringify({
      jev: {
        enabled: options.jev ?? false,
        ...(options.jevProvider ? { provider: options.jevProvider } : {}),
        ...(options.jevMaxSkills === undefined
          ? {}
          : { maxSkills: options.jevMaxSkills }),
      },
    }),
  )
  const skillPaths = Object.fromEntries(
    ["alpha", "beta", "plan"].map((name) => {
      const directory = join(root, name)
      mkdirSync(directory)
      const path = join(directory, "SKILL.md")
      writeFileSync(
        path,
        `---\nname: ${name}\ndescription: ${name} description\n---\n${options.skillBody?.[name] ?? `${name.toUpperCase()}_SKILL_BODY`}\n`,
      )
      return [name, path]
    }),
  )
  process.env["PI_CODING_AGENT_DIR"] = agentDir
  process.env["TYPESAFE_API_KEY"] = "test-key"
  delete process.env["OPENROUTER_API_KEY"]
  const authPath = join(agentDir, "auth.json")
  if (options.child === "unknown") delete globals[symbol]
  else
    globals[symbol] = Object.freeze({
      version: 1,
      isChildSession: () => options.child ?? false,
    })
  const payloads: Payload[] = []
  const requests: Array<{ url: string; init?: RequestInit }> = []
  globalThis.fetch = (async (url, init) => {
    requests.push({ url: String(url), ...(init ? { init } : {}) })
    const payload = JSON.parse(String(init?.body)) as Payload
    payloads.push(payload)
    if (options.fetch) return options.fetch(payload, init)
    const answers = Object.fromEntries(
      Object.entries(payload.questions).map(([key, question]) => [
        key,
        {
          type: "noul",
          noul: question.instructions.includes('"beta"') ? 0.99 : 0.1,
        },
      ]),
    )
    return Response.json({ answers })
  }) as typeof fetch
  const authProviders: string[] = []
  const notifications: string[] = []
  const calls: TranscriptContext[] = []
  const faux = fauxProvider({
    provider: `inline-regression-${roots.length}-${Date.now()}`,
  })
  faux.setResponses(
    options.responses.map((response) => async (context, ...rest) => {
      calls.push(structuredClone(context))
      return typeof response === "function"
        ? response(context, ...rest)
        : response
    }),
  )
  const settingsManager = SettingsManager.inMemory({
    retry: { enabled: false },
    ...options.settings,
  })
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noContextFiles: true,
    noThemes: true,
    noPromptTemplates: true,
    additionalSkillPaths: Object.values(skillPaths),
    skillsOverride: ({ skills, diagnostics }) => ({
      skills: skills.filter((skill) => Object.hasOwn(skillPaths, skill.name)),
      diagnostics,
    }),
    ...(options.templates
      ? {
          promptsOverride: () => ({
            prompts: options.templates!,
            diagnostics: [],
          }),
        }
      : {}),
    extensionFactories: [
      ...(options.beforeExtensions ?? []),
      inlineSkills,
      ...(options.extensions ?? []),
    ],
  })
  await loader.reload()
  const modelRuntime = await ModelRuntime.create({
    allowModelNetwork: false,
    authPath,
    modelsPath: null,
    refreshOnCreate: false,
  })
  modelRuntime.registerNativeProvider(faux.provider)
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    settingsManager,
    modelRuntime,
    model: faux.getModel(),
    ...(options.tools ? {} : { noTools: "all" as const }),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  })
  const ui = session.extensionRunner.getUIContext()
  const originalNotify = ui.notify.bind(ui)
  ui.notify = (message, level) => {
    notifications.push(message)
    originalNotify(message, level)
  }
  if (options.jevProvider === "openrouter") {
    session.extensionRunner.getModelRegistry().getApiKeyForProvider = async (
      provider,
    ) => {
      authProviders.push(provider)
      if (provider !== "openrouter") return undefined
      return options.resolveOpenRouterKey
        ? options.resolveOpenRouterKey()
        : "openrouter-test-key"
    }
  }
  const displayed: string[] = []
  session.subscribe((event) => {
    if (
      event.type === "message_start" &&
      event.message.role === "custom" &&
      event.message.customType === "inline-skill"
    )
      displayed.push(text(event.message))
  })
  return {
    session,
    faux,
    calls,
    payloads,
    requests,
    authProviders,
    notifications,
    skillPaths,
    modelRuntime,
    loader,
    settingsManager,
    cwd,
    agentDir,
    displayed,
    entries: () =>
      session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "inline-skill",
        ),
  }
}
