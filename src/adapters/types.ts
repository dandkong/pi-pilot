export type ChatPlatform = "telegram";

export type InlineButton = {
  text: string;
  callbackData: string;
};

export type TelegramCommand = {
  command: string;
  description: string;
};

export type ChatTextStream = {
  update(text: string): Promise<void>;
  finish(text: string): Promise<void>;
};

export type SentMessage = {
  messageId: string;
};

export type ChatMessage = {
  platform: ChatPlatform;
  chatId: string;
  messageId: string;
  userId: string;
  username?: string;
  text: string;
};

export type ChatCallback = {
  platform: ChatPlatform;
  chatId: string;
  messageId?: string;
  userId: string;
  callbackId: string;
  data: string;
};

export type MessageRenderMode = "plain" | "markdown";

export type SendMessageOptions = {
  replyToMessageId?: string;
  buttons?: InlineButton[][];
  render?: MessageRenderMode;
};

export type EditMessageOptions = {
  buttons?: InlineButton[][];
};

export interface ChatAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  sendMessage(chatId: string, text: string, options?: SendMessageOptions): Promise<SentMessage[]>;
  editMessage(chatId: string, messageId: string, text: string, options?: EditMessageOptions): Promise<void>;
  startTextStream(chatId: string, options?: SendMessageOptions): Promise<ChatTextStream | undefined>;
  sendTyping(chatId: string): Promise<void>;
  answerCallback(callback: ChatCallback, text?: string): Promise<void>;
  onMessage(handler: (message: ChatMessage) => Promise<void>): void;
  onCallback(handler: (callback: ChatCallback) => Promise<void>): void;
}
