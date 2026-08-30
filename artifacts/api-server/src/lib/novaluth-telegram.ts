import { logger } from "./logger";

const telegramApiBaseUrl = "https://api.telegram.org";
const requestTimeoutMs = 15_000;

export const novaLuthTelegramTestMessage = "Novaluth — test de supervision";

export type TelegramApiResponse = {
  ok: boolean;
  result?: Record<string, unknown>;
  error_code?: number;
  description?: string;
};

export class NovaLuthTelegramError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly statusCode?: number,
    readonly telegramResponse?: TelegramApiResponse,
  ) {
    super(message);
    this.name = "NovaLuthTelegramError";
  }
}

function telegramConfiguration() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    throw new NovaLuthTelegramError(
      "Telegram is not configured. TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required.",
      false,
    );
  }

  return { token, chatId };
}

export function isNovaLuthTelegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);
}

export async function sendNovaLuthTelegramMessage(
  text: string,
): Promise<TelegramApiResponse> {
  const { token, chatId } = telegramConfiguration();
  let response: Response;

  try {
    response = await fetch(
      `${telegramApiBaseUrl}/bot${token}/sendMessage`,
      {
        method: "POST",
        signal: AbortSignal.timeout(requestTimeoutMs),
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        }),
      },
    );
  } catch (error) {
    throw new NovaLuthTelegramError(
      "Telegram request failed before receiving a response.",
      true,
    );
  }

  let telegramResponse: TelegramApiResponse;
  try {
    telegramResponse = (await response.json()) as TelegramApiResponse;
  } catch {
    throw new NovaLuthTelegramError(
      `Telegram returned a non-JSON response with status ${response.status}.`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
    );
  }

  if (!response.ok || telegramResponse.ok !== true) {
    throw new NovaLuthTelegramError(
      telegramResponse.description ??
        `Telegram rejected the message with status ${response.status}.`,
      response.status === 408 || response.status === 429 || response.status >= 500,
      response.status,
      telegramResponse,
    );
  }

  logger.info("NovaLuth Telegram message sent");
  return telegramResponse;
}