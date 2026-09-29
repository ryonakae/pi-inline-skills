import { expect, test } from "bun:test"
import type { AgentMessage } from "@earendil-works/pi-agent-core"
import { buildConversationState } from "../src/conversation.ts"

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
}

test("conversation state excludes skill bodies, non-text blocks, and tool results", () => {
  const messages: AgentMessage[] = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '<skill name="plan" location="/tmp/plan/SKILL.md">\nSECRET_SKILL_BODY\n</skill>\n\n実装しますか？',
        },
        { type: "image", data: "SECRET_IMAGE", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "SECRET_THINKING" },
        { type: "text", text: "実装しますか？" },
        {
          type: "toolCall",
          id: "tool-1",
          name: "read",
          arguments: { path: "SECRET_TOOL_ARGUMENT" },
        },
      ],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage,
      stopReason: "toolUse",
      timestamp: 2,
    },
    {
      role: "toolResult",
      toolCallId: "tool-1",
      toolName: "read",
      content: [{ type: "text", text: "SECRET_TOOL_RESULT" }],
      isError: false,
      timestamp: 3,
    },
    {
      role: "user",
      content: [{ type: "text", text: "お願いします" }],
      timestamp: 4,
    },
  ]

  const result = buildConversationState(messages, "修正を続けて", {
    maxMessages: 6,
    maxChars: 12_000,
  })

  expect(result.messages).toEqual([
    { role: "user", text: "実装しますか？" },
    { role: "assistant", text: "実装しますか？" },
    { role: "user", text: "お願いします" },
    { role: "user", text: "修正を続けて" },
  ])
  expect(JSON.stringify(result)).not.toContain("SECRET_")
  expect(result.truncated).toBe(false)
})

test("an unparseable expanded skill message is omitted rather than leaked", () => {
  const messages = [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: '<skill name="broken" location="/tmp/SKILL.md">SECRET_BROKEN_BODY',
        },
      ],
      timestamp: 1,
    },
  ] as AgentMessage[]

  const result = buildConversationState(messages, "current", {
    maxMessages: 6,
    maxChars: 12_000,
  })

  expect(result.messages).toEqual([{ role: "user", text: "current" }])
  expect(JSON.stringify(result)).not.toContain("SECRET_BROKEN_BODY")
})

test.each([
  '<skill name="a" location="/a">SECRET_A</skill>\n<skill name="b" location="/b">SECRET_B</skill>\nrequest',
  'request <skill name="a" location="/a">SECRET_A</skill> <skill name="b" location="/b">SECRET_B</skill>',
])("current and history remove every expanded block: %s", (expanded) => {
  const result = buildConversationState(
    [
      { role: "user", content: expanded, timestamp: 1 },
      {
        role: "assistant",
        content: [{ type: "text", text: expanded }],
        api: "faux",
        provider: "faux",
        model: "faux",
        usage,
        stopReason: "stop",
        timestamp: 2,
      },
    ],
    expanded,
    { maxMessages: 6, maxChars: 12000 },
  )
  expect(result.messages.map((message) => message.text)).toEqual([
    "request",
    "request",
    "request",
  ])
  expect(JSON.stringify(result)).not.toContain("SECRET_")
})

test.each([
  '<skill name="a" location="/a">SECRET_A</skill> request <skill name="b" location="/b">SECRET_B',
  "request <skill broken>SECRET_B</skill>",
  "request </skill> SECRET_B",
  "request <skill",
  '<skill name="a" location="/a"><skill name="b" location="/b">SECRET_B</skill></skill>',
])("malformed current and history are omitted: %s", (expanded) => {
  const result = buildConversationState(
    [{ role: "user", content: expanded, timestamp: 1 }],
    expanded,
    { maxMessages: 6, maxChars: 12000 },
  )
  expect(result.messages).toEqual([])
})

test("conversation limits prefer newer messages and report truncation", () => {
  const messages = [
    {
      role: "user",
      content: [{ type: "text", text: "oldest" }],
      timestamp: 1,
    },
    {
      role: "assistant",
      content: [{ type: "text", text: "recent assistant" }],
      api: "faux",
      provider: "faux",
      model: "faux-1",
      usage,
      stopReason: "stop",
      timestamp: 2,
    },
  ] as AgentMessage[]

  const result = buildConversationState(messages, "current", {
    maxMessages: 2,
    maxChars: 24,
  })

  expect(result.messages).toEqual([
    { role: "assistant", text: "recent assistant" },
    { role: "user", text: "current" },
  ])
  expect(result.truncated).toBe(true)
})
