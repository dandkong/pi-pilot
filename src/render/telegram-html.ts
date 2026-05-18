import MarkdownIt from "markdown-it";
import type Renderer from "markdown-it/lib/renderer.mjs";
import type Token from "markdown-it/lib/token.mjs";

const markdown = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: false,
});
markdown.disable(["table"]);

const rules = markdown.renderer.rules;
rules.paragraph_open = () => "";
rules.paragraph_close = (tokens, index) => (tokens[index]?.hidden ? "" : "\n\n");
rules.heading_open = () => "<b>";
rules.heading_close = () => "</b>\n\n";
rules.strong_open = () => "<b>";
rules.strong_close = () => "</b>";
rules.em_open = () => "<i>";
rules.em_close = () => "</i>";
rules.s_open = () => "<s>";
rules.s_close = () => "</s>";
rules.bullet_list_open = (_tokens, _index, _options, env) => {
  getListStack(env).push({ type: "bullet" });
  return "";
};
rules.bullet_list_close = (_tokens, _index, _options, env) => {
  getListStack(env).pop();
  return "\n";
};
rules.ordered_list_open = (tokens, index, _options, env) => {
  const start = Number(tokens[index]?.attrGet("start") ?? "1");
  getListStack(env).push({ type: "ordered", next: Number.isFinite(start) ? start : 1 });
  return "";
};
rules.ordered_list_close = (_tokens, _index, _options, env) => {
  getListStack(env).pop();
  return "\n";
};
rules.list_item_open = (_tokens, _index, _options, env) => {
  const current = getListStack(env).at(-1);
  if (current?.type !== "ordered") return "- ";
  return `${current.next++}. `;
};
rules.list_item_close = () => "\n";
rules.blockquote_open = () => "<blockquote>";
rules.blockquote_close = () => "</blockquote>\n\n";
rules.hr = () => "---\n\n";
rules.softbreak = () => "\n";
rules.hardbreak = () => "\n";
rules.code_inline = (tokens, index) => `<code>${escapeHtml(tokens[index]?.content ?? "")}</code>`;
rules.code_block = (tokens, index) => renderCodeBlock(tokens[index]?.content ?? "");
rules.fence = (tokens, index) => renderCodeBlock(tokens[index]?.content ?? "");
rules.link_open = renderLinkOpen;
rules.link_close = () => "</a>";

export function renderTelegramHtml(text: string): string {
  return markdown.render(text, {}).trim();
}

type ListFrame = { type: "bullet" } | { type: "ordered"; next: number };

type RenderEnv = {
  listStack?: ListFrame[];
};

function getListStack(env: unknown): ListFrame[] {
  const renderEnv = env as RenderEnv;
  renderEnv.listStack ??= [];
  return renderEnv.listStack;
}

function renderCodeBlock(content: string): string {
  return `<pre><code>${escapeHtml(content.replace(/\n$/, ""))}</code></pre>\n\n`;
}

function renderLinkOpen(tokens: Token[], index: number, _options: unknown, _env: unknown, self: Renderer): string {
  const href = tokens[index]?.attrGet("href");
  if (!href || !isSafeUrl(href)) return "";
  return `<a href="${escapeHtml(href)}">`;
}

function isSafeUrl(url: string): boolean {
  return /^(https?:|tg:)/i.test(url);
}

function escapeHtml(value: string): string {
  return markdown.utils.escapeHtml(value);
}
