import { randomUUID } from "crypto";

/**
 * Send a fake GreenAPI webhook to a running instance of the app.
 *
 *   npm run send-webhook -- "Да, я собственник"
 *   INSTANCE_ID=mock-instance-1 CHAT_ID=995555123456@c.us npm run send-webhook
 */
async function main(): Promise<void> {
  const baseUrl = process.env.APP_URL ?? "http://localhost:3000";
  const instanceId = process.env.INSTANCE_ID ?? "mock-instance-1";
  const chatId = process.env.CHAT_ID ?? "995555123456@c.us";
  const text = process.argv.slice(2).join(" ").trim() || "Да, я собственник, можно работать";

  const payload = {
    typeWebhook: "incomingMessageReceived",
    idMessage: process.env.ID_MESSAGE ?? `manual-${randomUUID()}`,
    timestamp: Math.floor(Date.now() / 1000),
    instanceData: { idInstance: instanceId, typeInstance: "whatsapp" },
    senderData: { chatId, chatName: "Manual test", sender: chatId, senderName: "Manual test" },
    messageData: { typeMessage: "textMessage", textMessageData: { textMessage: text } },
  };

  const response = await fetch(`${baseUrl}/webhooks/greenapi/${instanceId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const body = await response.json().catch(() => ({}));
  console.log(`HTTP ${response.status}`, body);
}

void main().catch((error) => {
  console.error("Failed to send webhook:", error);
  process.exit(1);
});
