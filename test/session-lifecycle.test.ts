import { expect, test } from "bun:test"
import { join } from "node:path"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  SessionManager,
  type CreateAgentSessionRuntimeFactory,
} from "@earendil-works/pi-coding-agent"
import inlineSkills from "../src/index.ts"
import { restoreLoadedSkillNames } from "../src/loaded-skills.ts"
import { bodyCount, setup, text, waitFor } from "./harness.ts"

test("tree navigation restores only the active branch, including identical manual input", async () => {
  const h = await setup({
    jev: true,
    responses: [
      fauxAssistantMessage("original"),
      fauxAssistantMessage("alternate"),
    ],
  })
  try {
    await h.session.prompt("/alpha same")
    const user = h.session.sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!
    await h.session.navigateTree(user.id)
    expect(h.entries()).toHaveLength(0)
    await h.session.prompt("/alpha same")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(2)
    expect(h.entries().map((entry) => entry.display)).toEqual([true, false])
    expect(h.payloads).toHaveLength(2)
  } finally {
    h.session.dispose()
  }
})

test("reload restores persisted loads and reads updated virtual templates without stale recommendations", async () => {
  const templates = [
    {
      name: "virtual",
      description: "test",
      content: "/alpha first",
      filePath: "/virtual/test.md",
      sourceInfo: {
        path: "/virtual/test.md",
        source: "local",
        scope: "temporary" as const,
        origin: "top-level" as const,
      },
    },
  ]
  const h = await setup({
    jev: true,
    templates,
    responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
  })
  try {
    await h.session.prompt("/virtual")
    templates[0]!.content = "/beta updated"
    await h.session.reload()
    await h.session.prompt("/virtual")
    expect(h.payloads[1]!.state.currentInput).toBe("/beta updated")
    expect(h.payloads[1]!.state.loadedSkills).toContain("alpha")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.calls[1]!.messages.map(text).join("\n")).not.toContain(
      "<skill_read_instructions>",
    )
  } finally {
    h.session.dispose()
  }
})

test.each(["abort", "tree", "switch", "end"] as const)(
  "credentials resolving after %s do not start Jev HTTP",
  async (event) => {
    let releaseAuth!: (key: string) => void
    const auth = new Promise<string>((resolve) => {
      releaseAuth = resolve
    })
    const h = await setup({
      jev: true,
      jevProvider: "openrouter",
      resolveOpenRouterKey: () => auth,
      responses: [fauxAssistantMessage("done")],
    })
    try {
      const run = h.session.prompt("investigate")
      await waitFor(() => h.authProviders.length === 1)
      let aborting: Promise<void> | undefined
      if (event === "abort") aborting = h.session.abort()
      else if (event === "tree")
        await h.session.extensionRunner.emit({
          type: "session_tree",
          newLeafId: "new",
          oldLeafId: "old",
        })
      else if (event === "switch")
        await h.session.extensionRunner.emit({
          type: "session_before_switch",
          reason: "new",
        })
      else
        await h.session.extensionRunner.emit({
          type: "agent_end",
          messages: [],
        })
      releaseAuth("OPENROUTER_SYNTHETIC_KEY")
      await aborting
      await run
      expect(h.requests).toEqual([])
      expect(h.authProviders).toEqual(["openrouter"])
      for (const call of h.calls) {
        expect(call.messages.map(text).join("\n")).not.toContain(
          "<skill_read_instructions>",
        )
      }
    } finally {
      releaseAuth("OPENROUTER_SYNTHETIC_KEY")
      h.session.dispose()
    }
  },
)

test("a batch change while credentials are pending sends only the current batch", async () => {
  let releaseAuth!: (key: string) => void
  const auth = new Promise<string>((resolve) => {
    releaseAuth = resolve
  })
  const h = await setup({
    jev: true,
    jevProvider: "openrouter",
    resolveOpenRouterKey: () => auth,
    responses: [fauxAssistantMessage("done")],
  })
  try {
    const run = h.session.prompt("original batch")
    await waitFor(() => h.authProviders.length === 1)
    h.session.sessionManager.appendMessage({
      role: "user",
      content: "replacement batch",
      timestamp: Date.now(),
    })
    const currentContext = h.session.extensionRunner.emitContext(
      h.session.sessionManager.buildSessionProjection().messages,
    )
    await waitFor(() => h.authProviders.length === 2)
    releaseAuth("OPENROUTER_SYNTHETIC_KEY")
    await currentContext
    await run
    expect(h.requests).toHaveLength(1)
    expect(h.payloads[0]!.state.currentInput).toBe(
      "original batch\n\nreplacement batch",
    )
  } finally {
    releaseAuth("OPENROUTER_SYNTHETIC_KEY")
    h.session.dispose()
  }
})

test("compaction keeps historical load records while allowing a missing manual body to reload", async () => {
  const h = await setup({
    settings: { compaction: { keepRecentTokens: 1 } },
    extensions: [
      (pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "The alpha skill was used.",
            firstKeptEntryId: event.branchEntries.at(-1)!.id,
            tokensBefore: 100,
          },
        }))
      },
    ],
    responses: [
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("third"),
    ],
  })
  try {
    await h.session.prompt("/alpha first")
    await h.session.prompt("another turn")
    await h.session.compact()
    await h.session.prompt("/alpha again")
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(2)
    expect(h.notifications).toEqual([
      "Skill loaded: alpha",
      "Skill loaded: alpha",
    ])
    expect([
      ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
    ]).toEqual(["alpha"])
  } finally {
    h.session.dispose()
  }
})

test("context edit reports a removed manual body as newly loaded again", async () => {
  const h = await setup({
    responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
  })
  try {
    await h.session.prompt("/alpha first")
    h.session.sessionManager.appendContextEdit(h.entries()[0]!.id, {
      content: "body removed",
    })
    await h.session.prompt("/alpha again")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(h.notifications).toEqual([
      "Skill loaded: alpha",
      "Skill loaded: alpha",
    ])
  } finally {
    h.session.dispose()
  }
})

test("compaction lets a missing automatic body be selected again without restoring it eagerly", async () => {
  const h = await setup({
    jev: true,
    settings: { compaction: { keepRecentTokens: 1 } },
    extensions: [
      (pi) => {
        pi.on("session_before_compact", (event) => ({
          compaction: {
            summary: "The beta skill was used.",
            firstKeptEntryId: event.branchEntries.at(-1)!.id,
            tokensBefore: 100,
          },
        }))
      },
    ],
    responses: [
      fauxAssistantMessage("first"),
      fauxAssistantMessage("second"),
      fauxAssistantMessage("third"),
    ],
  })
  try {
    await h.session.prompt("investigate")
    await h.session.prompt("another turn")
    await h.session.compact()
    await h.session.prompt("investigate again")
    expect(h.payloads.at(-1)!.state.loadedSkills).not.toContain("beta")
    expect(bodyCount(h.calls[2]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(2)
    expect(h.notifications).toEqual([
      "Skill automatically loaded by Jev: beta",
      "Skill automatically loaded by Jev: beta",
    ])
    expect([
      ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
    ]).toEqual(["beta"])
  } finally {
    h.session.dispose()
  }
})

test("context edit lets a removed automatic body be selected again", async () => {
  const h = await setup({
    jev: true,
    responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
  })
  try {
    await h.session.prompt("investigate")
    const automatic = h.entries()[0]!
    h.session.sessionManager.appendContextEdit(automatic.id, {
      content: "body removed",
    })
    await h.session.prompt("investigate again")
    expect(h.payloads[1]!.state.loadedSkills).not.toContain("beta")
    expect(bodyCount(h.calls[1]!, "beta")).toBe(1)
    expect(h.entries()).toHaveLength(2)
    expect(h.notifications).toEqual([
      "Skill automatically loaded by Jev: beta",
      "Skill automatically loaded by Jev: beta",
    ])
  } finally {
    h.session.dispose()
  }
})

test("a compacted native body can be loaded manually without changing native expansion", async () => {
  const h = await setup({
    responses: [fauxAssistantMessage("first"), fauxAssistantMessage("second")],
  })
  try {
    await h.session.prompt("/skill:alpha first")
    const assistant = h.session.sessionManager
      .getBranch()
      .findLast(
        (entry) =>
          entry.type === "message" && entry.message.role === "assistant",
      )!
    h.session.sessionManager.appendCompaction(
      "The alpha skill was used.",
      assistant.id,
      100,
    )
    await h.session.prompt("/alpha again")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
  } finally {
    h.session.dispose()
  }
})

test("successful read state follows the projected result across compaction and context edit", async () => {
  let path = ""
  const h = await setup({
    tools: true,
    responses: [
      () =>
        fauxAssistantMessage(fauxToolCall("read", { path }), {
          stopReason: "toolUse",
        }),
      fauxAssistantMessage("read complete"),
      fauxAssistantMessage("kept"),
      fauxAssistantMessage("reloaded"),
    ],
  })
  path = h.skillPaths["alpha"]!
  try {
    await h.session.prompt("inspect alpha")
    const branch = h.session.sessionManager.getBranch()
    const result = branch.find(
      (entry) =>
        entry.type === "message" && entry.message.role === "toolResult",
    )!
    const record = branch.find(
      (entry) => entry.type === "custom" && entry.customType === "loaded-skill",
    )!
    expect(branch.indexOf(record)).toBeGreaterThan(branch.indexOf(result))

    h.session.sessionManager.appendCompaction(
      "The alpha skill was read.",
      result.id,
      100,
    )
    await h.session.prompt("/alpha while result remains")
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(0)

    h.session.sessionManager.appendContextEdit(result.id, null)
    await h.session.prompt("/alpha after result removal")
    expect(bodyCount(h.calls[3]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect([
      ...restoreLoadedSkillNames(h.session.sessionManager.getBranch()),
    ]).toEqual(["alpha"])
  } finally {
    h.session.dispose()
  }
})

test("legacy read results retained without their calls still prevent duplicate loading", async () => {
  const h = await setup({
    responses: [fauxAssistantMessage("kept"), fauxAssistantMessage("reloaded")],
  })
  try {
    const manager = h.session.sessionManager
    const call = fauxToolCall("read", { path: h.skillPaths["alpha"]! })
    manager.appendMessage(fauxAssistantMessage(call, { stopReason: "toolUse" }))
    manager.appendCustomEntry("loaded-skill", {
      name: "alpha",
      source: "tool-result",
    })
    const resultId = manager.appendMessage({
      role: "toolResult",
      toolCallId: call.id,
      toolName: "read",
      content: [{ type: "text", text: "ALPHA_SKILL_BODY" }],
      isError: false,
      timestamp: Date.now(),
    })
    manager.appendMessage(fauxAssistantMessage("legacy read complete"))
    manager.appendCompaction("Alpha was used.", resultId, 100)
    await h.session.prompt("/alpha while legacy result remains")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(0)

    manager.appendContextEdit(resultId, null)
    await h.session.prompt("/alpha after legacy result removal")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(h.entries()).toHaveLength(1)
    expect([...restoreLoadedSkillNames(manager.getBranch())]).toEqual(["alpha"])
  } finally {
    h.session.dispose()
  }
})

test("runtime newSession, fork, and switch recreate extension state against the target branch", async () => {
  const h = await setup({
    jev: true,
    responses: Array.from({ length: 4 }, () => fauxAssistantMessage("done")),
  })
  h.session.dispose()
  const factory: CreateAgentSessionRuntimeFactory = async ({
    cwd,
    agentDir,
    sessionManager,
    sessionStartEvent,
  }) => {
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      modelRuntime: h.modelRuntime,
      settingsManager: h.settingsManager,
      resourceLoaderOptions: {
        noExtensions: true,
        noSkills: true,
        noContextFiles: true,
        noPromptTemplates: true,
        noThemes: true,
        additionalSkillPaths: Object.values(h.skillPaths),
        extensionFactories: [inlineSkills],
      },
    })
    return {
      ...(await createAgentSessionFromServices({
        services,
        sessionManager,
        ...(sessionStartEvent ? { sessionStartEvent } : {}),
        model: h.faux.getModel(),
        noTools: "all",
      })),
      services,
      diagnostics: services.diagnostics,
    }
  }
  const runtime = await createAgentSessionRuntime(factory, {
    cwd: h.cwd,
    agentDir: h.agentDir,
    sessionManager: SessionManager.create(h.cwd, join(h.agentDir, "sessions")),
  })
  try {
    await runtime.session.prompt("/alpha original")
    const firstSession = runtime.session
    const originalFile = runtime.session.sessionFile!
    const user = runtime.session.sessionManager
      .getBranch()
      .find(
        (entry) => entry.type === "message" && entry.message.role === "user",
      )!
    await runtime.fork(user.id, { position: "before" })
    expect(runtime.session).not.toBe(firstSession)
    await runtime.session.prompt("/alpha fork")
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    await runtime.newSession()
    expect([
      ...restoreLoadedSkillNames(runtime.session.sessionManager.getBranch()),
    ]).toEqual([])
    await runtime.session.prompt("/alpha new")
    expect(bodyCount(h.calls[2]!, "alpha")).toBe(1)
    await runtime.switchSession(originalFile)
    await runtime.session.prompt("/alpha restored")
    expect(bodyCount(h.calls[3]!, "alpha")).toBe(1)
    expect(
      runtime.session.sessionManager
        .getBranch()
        .filter(
          (entry) =>
            entry.type === "custom_message" &&
            entry.customType === "inline-skill",
        ),
    ).toHaveLength(2)
    expect(h.payloads).toHaveLength(4)
  } finally {
    await runtime.dispose()
  }
})
