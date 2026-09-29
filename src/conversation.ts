import type { AgentMessage } from "@earendil-works/pi-agent-core"

type ConversationMessage = {
  role: "user" | "assistant"
  text: string
}

type ConversationLimits = {
  maxMessages: number
  maxChars: number
}

export type ConversationState = {
  messages: ConversationMessage[]
  currentInput: string
  truncated: boolean
}

export function textContent(message: AgentMessage): string {
  if (message.role !== "user" && message.role !== "assistant") return ""
  if (typeof message.content === "string") return message.content
  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
}

export function skillRequestText(text: string): string {
  let malformed = false
  const withoutBlocks = text.replace(
    /<skill\b([^>]*)>([\s\S]*?)<\/skill\s*>/giu,
    (_block, attributes: string, body: string) => {
      if (
        !/\bname="[^"]+"/u.test(attributes) ||
        !/\blocation="[^"]+"/u.test(attributes) ||
        /<\/?skill\b/iu.test(body)
      )
        malformed = true
      return ""
    },
  )
  // A remaining delimiter may enclose private instructions, so omit the entire text.
  if (malformed || /<\/?skill\b/iu.test(withoutBlocks)) return ""
  return withoutBlocks.trim()
}

export function buildConversationState(
  history: AgentMessage[],
  currentInput: string | string[],
  limits: ConversationLimits,
): ConversationState {
  type Part = ConversationMessage & { current: boolean }
  const eligible = history.flatMap((message): Part[] => {
    if (message.role !== "user" && message.role !== "assistant") return []
    const text = skillRequestText(textContent(message))
    return text ? [{ role: message.role, text, current: false }] : []
  })
  for (const input of Array.isArray(currentInput)
    ? currentInput
    : [currentInput]) {
    const text = skillRequestText(input)
    if (text) eligible.push({ role: "user", text, current: true })
  }

  let truncated = eligible.length > limits.maxMessages
  const byCount = eligible.slice(-limits.maxMessages)
  const selected: Part[] = []
  let remaining = limits.maxChars
  for (let index = byCount.length - 1; index >= 0; index -= 1) {
    const message = byCount[index]
    if (!message) continue
    if (message.text.length <= remaining) {
      selected.push(message)
      remaining -= message.text.length
      continue
    }
    truncated = true
    if (selected.length === 0 && remaining > 0) {
      selected.push({ ...message, text: message.text.slice(0, remaining) })
    }
    break
  }

  const retained = selected.toReversed()
  return {
    messages: retained.map(({ role, text }) => ({ role, text })),
    currentInput: retained
      .filter((part) => part.current)
      .map((part) => part.text)
      .join("\n\n"),
    truncated,
  }
}
