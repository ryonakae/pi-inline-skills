import type { ExtensionContext } from "@earendil-works/pi-coding-agent"

export function consumedInputBatch(ctx: ExtensionContext) {
  const projection = ctx.sessionManager.buildSessionProjection()
  const projected = projection.entries.flatMap((entry) =>
    entry.messages.map((message) => ({
      message,
      sourceEntry: entry.sourceEntry,
    })),
  )
  const lastUser = projected.findLastIndex(
    ({ message, sourceEntry }) =>
      sourceEntry.type === "message" &&
      sourceEntry.message.role === "user" &&
      message.role === "user",
  )
  if (lastUser < 0) return undefined
  let start = lastUser
  while (start > 0 && projected[start - 1]?.message.role !== "assistant")
    start--
  const users = projected
    .slice(start, lastUser + 1)
    .filter(
      ({ message, sourceEntry }) =>
        sourceEntry.type === "message" &&
        sourceEntry.message.role === "user" &&
        message.role === "user",
    )
  return {
    key: users.map(({ sourceEntry }) => sourceEntry.id).join("\u0000"),
    users,
    history: projected.slice(0, start).map(({ message }) => message),
  }
}
