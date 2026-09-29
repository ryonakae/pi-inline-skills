import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent"
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai"
import inlineSkills from "../src/index.ts"

test.each([
  ["auth", "/skill:beta next"],
  ["auth", "/template next"],
  ["model", "/skill:beta next"],
  ["model", "/template next"],
] as const)(
  "preflight %s failure must not leak alpha into %s",
  async (failure, nextInput) => {
    const root = mkdtempSync("/tmp/pi-inline-preflight-")
    const agentDir = join(root, "agent")
    const cwd = join(root, "workspace")
    const previousAgentDir = process.env["PI_CODING_AGENT_DIR"]
    process.env["PI_CODING_AGENT_DIR"] = agentDir
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(agentDir, "prompts"), { recursive: true })
    writeFileSync(
      join(agentDir, "prompts", "template.md"),
      "TEMPLATE_BODY $ARGUMENTS",
    )
    const paths = ["alpha", "beta"].map((name) => {
      const dir = join(root, name)
      mkdirSync(dir)
      const path = join(dir, "SKILL.md")
      writeFileSync(
        path,
        `---\nname: ${name}\ndescription: ${name}\n---\n${name.toUpperCase()}_SKILL_BODY`,
      )
      return path
    })
    const settingsManager = SettingsManager.inMemory({
      retry: { enabled: false },
    })
    const events: string[] = []
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      additionalSkillPaths: paths,
      noSkills: true,
      noExtensions: true,
      noContextFiles: true,
      noThemes: true,
      extensionFactories: [
        inlineSkills,
        (pi) => {
          pi.on("input", () => {
            events.push("input")
          })
          pi.on("before_agent_start", () => {
            events.push("before_agent_start")
          })
          pi.on("agent_settled", () => {
            events.push("agent_settled")
          })
        },
      ],
    })
    await loader.reload()
    const modelRuntime = await ModelRuntime.create({
      allowModelNetwork: false,
      modelsPath: null,
      refreshOnCreate: false,
    })
    const faux = fauxProvider({ provider: "preflight-cycle2-faux" })
    modelRuntime.registerNativeProvider(faux.provider)
    let text = ""
    faux.setResponses([
      (context) => {
        text = JSON.stringify(context.messages)
        return fauxAssistantMessage("done")
      },
    ])
    const { session } = await createAgentSession({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      model: faux.getModel(),
      noTools: "all",
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(cwd),
    })
    try {
      if (failure === "auth") modelRuntime.unregisterProvider(faux.provider.id)
      else Reflect.deleteProperty(session.agent.state, "model")
      await expect(session.prompt("/alpha failed input")).rejects.toThrow()
      expect(events).toEqual(["input"])
      expect(faux.state.callCount).toBe(0)
      if (failure === "auth") modelRuntime.registerNativeProvider(faux.provider)
      else session.agent.state.model = faux.getModel()
      await session.prompt(nextInput)
      expect(faux.state.callCount).toBe(1)
      expect(text).toContain(
        nextInput.startsWith("/skill:") ? "BETA_SKILL_BODY" : "TEMPLATE_BODY",
      )
      expect(text).not.toContain("ALPHA_SKILL_BODY")
    } finally {
      session.dispose()
      if (previousAgentDir === undefined)
        delete process.env["PI_CODING_AGENT_DIR"]
      else process.env["PI_CODING_AGENT_DIR"] = previousAgentDir
      rmSync(root, { recursive: true })
    }
  },
)
