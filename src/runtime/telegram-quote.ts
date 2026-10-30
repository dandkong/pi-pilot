const TELEGRAM_REPLY_QUOTE_LIMIT_UTF16 = 3_500;

function truncateUtf16Text(value: string, limit: number, suffix: string): string {
  if (value.length <= limit) return value;
  const safePrefix = (text: string, maxUnits: number) => {
    let end = Math.min(text.length, maxUnits);
    if (end > 0) {
      const last = text.charCodeAt(end - 1);
      if (last >= 0xd800 && last <= 0xdbff) end--;
    }
    return text.slice(0, end);
  };
  const ending = safePrefix(suffix, limit);
  return `${safePrefix(value, Math.max(0, limit - ending.length))}${ending}`;
}

/** Add a bounded Telegram reply as Markdown context without creating a second message. */
export function withTelegramQuote(messageText: string, replyText?: string): string {
  const text = messageText.trim();
  const quote = replyText?.replace(/\r\n?/g, "\n").trim();
  if (!quote) return text;

  const excerpt = truncateUtf16Text(quote, TELEGRAM_REPLY_QUOTE_LIMIT_UTF16, "…");
  const blockquote = excerpt.split("\n").map(line => `> ${line}`).join("\n");
  return `${blockquote}${text ? `\n\n${text}` : ""}`;
}
