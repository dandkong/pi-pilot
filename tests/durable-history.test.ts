import { expect, spyOn, test } from "bun:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  createRegistry,
  Harness,
  MemoryStorage,
  UserEntry,
} from "@earendil-works/pi-durable";
import { ConversationHistory } from "../src/pi/history.ts";

test("recent history reads one page and cached totals invalidate on committed entries", async () => {
  const harness = await Harness.open(
    new MemoryStorage(),
    { models: createModels(), registry: createRegistry() },
    BACKGROUND_CONTEXT,
  );
  const conversation = await harness.createConversation(
    { ownership: { kind: "ownerless" } },
    BACKGROUND_CONTEXT,
  );
  const history = new ConversationHistory(harness);
  const entries = spyOn(conversation, "entries");
  try {
    await conversation.commit(async (tx) => {
      for (let i = 0; i < 1_000; i++) {
        await tx.appendEntry(UserEntry, conversation.id, {
          model: [{ role: "user", content: `Question ${i}`, timestamp: i + 1 }],
        });
      }
    }, BACKGROUND_CONTEXT);
    expect(await history.recent(conversation, 2)).toEqual([
      { role: "User", text: "Question 998" },
      { role: "User", text: "Question 999" },
    ]);
    expect(entries).toHaveBeenCalledTimes(1);
    const summary = await history.summary(conversation);
    expect(summary.stats.userMessages).toBe(1_000);
    expect(summary.firstMessage).toBe("Question 0");
    const calls = entries.mock.calls.length;
    expect(await history.summary(conversation)).toEqual(summary);
    expect(entries).toHaveBeenCalledTimes(calls);
    await conversation.commit(async (tx) => {
      await tx.appendEntry(UserEntry, conversation.id, {
        model: [{ role: "user", content: "Newest question", timestamp: 1_001 }],
      });
    }, BACKGROUND_CONTEXT);
    expect((await history.summary(conversation)).stats.userMessages).toBe(
      1_001,
    );
    expect(await history.latestActivity(conversation, 0)).toBe(1_001);
  } finally {
    entries.mockRestore();
    history.dispose();
    await harness.close(BACKGROUND_CONTEXT);
  }
});
