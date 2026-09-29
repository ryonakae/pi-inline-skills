import { expect, test } from "bun:test"
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai"
import { bodyCount, gate, setup, text, waitFor } from "./harness.ts"

const template = (content: string) => ({
  name: "template",
  description: "Virtual template",
  content,
  filePath: "/virtual/template.md",
  sourceInfo: {
    source: "local",
    scope: "temporary" as const,
    origin: "top-level" as const,
    path: "/virtual/template.md",
  },
})

test("raw input transformed by another extension is not loaded or sent twice", async () => {
  const h = await setup({
    jev: true,
    beforeExtensions: [
      (pi) => {
        pi.on("input", () => ({
          action: "transform",
          text: "/beta transformed",
        }))
      },
    ],
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("/alpha raw")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(0)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(1)
    expect(h.payloads[0]!.state.currentInput).toBe("/beta transformed")
    expect(JSON.stringify(h.payloads)).not.toContain("/alpha raw")
  } finally {
    h.session.dispose()
  }
})

test("manual loading and Jev see the expanded virtual template exactly once", async () => {
  const h = await setup({
    jev: true,
    templates: [template("/alpha EXPANDED $ARGUMENTS")],
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("/template input")
    expect(h.calls[0]!.messages.map(text)).toContain("/alpha EXPANDED input")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(h.payloads[0]!.state.currentInput).toBe("/alpha EXPANDED input")
    expect(h.payloads[0]!.state.conversation).toEqual([
      { role: "user", text: "/alpha EXPANDED input" },
    ])
  } finally {
    h.session.dispose()
  }
})

test("a slash-leading expanded template is manual even when its token also names a template", async () => {
  const h = await setup({
    templates: [
      template("/alpha final"),
      { ...template("/beta WRONG_SECOND_EXPANSION"), name: "alpha" },
    ],
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("/template")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
    expect(h.calls[0]!.messages.map(text)).toContain("/alpha final")
  } finally {
    h.session.dispose()
  }
})

test("a template whose expansion starts with another template is not expanded twice", async () => {
  const second = { ...template("UNEXPECTED_SECOND_EXPANSION"), name: "second" }
  const h = await setup({
    jev: true,
    templates: [template("/second argument"), second],
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("/template")
    expect(h.calls[0]!.messages.map(text)).toContain("/second argument")
    expect(h.payloads[0]!.state.currentInput).toBe("/second argument")
    expect(h.calls[0]!.messages.map(text).join("\n")).not.toContain(
      "UNEXPECTED_SECOND_EXPANSION",
    )
  } finally {
    h.session.dispose()
  }
})

test("native skill bodies do not activate slash references inside the body", async () => {
  const h = await setup({
    jev: true,
    skillBody: { alpha: "ALPHA_SKILL_BODY mentions /beta and /plan" },
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt("/skill:alpha investigate")
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[0]!, "beta")).toBe(0)
    expect(bodyCount(h.calls[0]!, "plan")).toBe(0)
    expect(h.entries()).toHaveLength(0)
    expect(h.payloads[0]!.state.currentInput).toBe("investigate")
    expect(h.payloads[0]!.state.explicitSkills).toContain("alpha")
    expect(JSON.stringify(h.payloads)).not.toContain("SKILL_BODY")
  } finally {
    h.session.dispose()
  }
})

test("disabled native expansion remains Pi's decision while manual tokens still work", async () => {
  const h = await setup({
    responses: [
      fauxAssistantMessage("native disabled"),
      fauxAssistantMessage("manual"),
    ],
  })
  try {
    await h.session.prompt("/skill:alpha", { expandPromptTemplates: false })
    expect(bodyCount(h.calls[0]!, "alpha")).toBe(0)
    await h.session.prompt("/alpha", { expandPromptTemplates: false })
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
  } finally {
    h.session.dispose()
  }
})

test("other extensions' user messages are eligible, but custom messages are not", async () => {
  const hold = gate()
  let sendUser!: () => void
  const h = await setup({
    jev: true,
    extensions: [
      (pi) => {
        sendUser = () => {
          pi.sendMessage(
            {
              customType: "external",
              content: "SECRET_CUSTOM /plan",
              display: false,
            },
            { triggerTurn: false },
          )
          pi.sendUserMessage("/alpha EXTENSION_INPUT", { deliverAs: "steer" })
        }
      },
    ],
    responses: [
      async () => {
        await hold.promise
        return fauxAssistantMessage("initial")
      },
      fauxAssistantMessage("extension"),
    ],
  })
  try {
    const run = h.session.prompt("initial")
    await waitFor(() => h.calls.length === 1)
    sendUser()
    hold.release()
    await run
    expect(bodyCount(h.calls[1]!, "alpha")).toBe(1)
    expect(bodyCount(h.calls[1]!, "plan")).toBe(0)
    expect(h.payloads[1]!.state.currentInput).toBe("/alpha EXTENSION_INPUT")
    expect(JSON.stringify(h.payloads)).not.toContain("SECRET_CUSTOM")
  } finally {
    hold.release()
    h.session.dispose()
  }
})

test("fetch excludes all current/history skill bodies, custom/tool/thinking/image content", async () => {
  const expanded =
    '<skill name="external-a" location="/a">\nSECRET_SKILL_A\n</skill>\n\n<skill name="external-b" location="/b">\nSECRET_SKILL_B\n</skill>\n\n'
  const h = await setup({
    jev: true,
    tools: true,
    settings: { images: { autoResize: false } },
    extensions: [
      (pi) => {
        pi.on("before_agent_start", () => ({
          message: {
            customType: "other",
            content: "SECRET_CUSTOM",
            display: false,
          },
        }))
      },
    ],
    responses: [
      fauxAssistantMessage(
        [
          { type: "thinking", thinking: "SECRET_THINKING" },
          { type: "text", text: "visible assistant" },
          fauxToolCall("read", { path: "/SECRET_TOOL_ARGUMENT" }),
        ],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage("visible result"),
      fauxAssistantMessage("done"),
    ],
  })
  try {
    await h.session.prompt(`${expanded}first`, {
      images: [
        {
          type: "image",
          data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXuoAAAAASUVORK5CYII=",
          mimeType: "image/png",
        },
      ],
    })
    await h.session.prompt(`second ${expanded}request`)
    expect(h.payloads).toHaveLength(2)
    expect(h.payloads[0]!.state.currentInput).toBe("first")
    expect(h.payloads[1]!.state.currentInput).toBe("second \n\n\n\nrequest")
    expect(
      h.payloads[1]!.state.conversation.filter(
        (message) => message.text === "first",
      ),
    ).toHaveLength(1)
    expect(JSON.stringify(h.payloads)).not.toContain("SECRET_")
    expect(JSON.stringify(h.payloads)).not.toContain("iVBORw0KGgo")
  } finally {
    h.session.dispose()
  }
})

test("malformed current strings are never sent to Jev or scanned for manual references", async () => {
  const h = await setup({
    jev: true,
    responses: [fauxAssistantMessage("done")],
  })
  try {
    await h.session.prompt(
      '/alpha <skill name="broken" location="/x">SECRET_BROKEN /beta',
    )
    expect(h.payloads).toHaveLength(0)
    expect(h.entries()).toHaveLength(0)
  } finally {
    h.session.dispose()
  }
})
