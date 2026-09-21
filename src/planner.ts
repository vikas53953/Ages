export type LocalPlan =
  | { tool: "read"; path: string }
  | { tool: "grep"; pattern: string; path: string }
  | { tool: "none" };

function cleanPath(raw: string) {
  return raw.trim().replace(/^["']|["']$/g, "") || ".";
}

export function planLocal(prompt: string): LocalPlan {
  const text = prompt.trim();
  const read = text.match(/^(?:read|open|cat|show)\s+(\S+)/i);
  if (read) return { tool: "read", path: cleanPath(read[1]) };

  const grep = text.match(/^(?:search|find|grep)\s+(?:for\s+)?(.+)$/i);
  if (grep) return { tool: "grep", pattern: grep[1].trim(), path: "." };

  if (/\b(list|ls|files|folder|directory|cwd)\b/i.test(text)) {
    return { tool: "read", path: "." };
  }
  return { tool: "none" };
}
