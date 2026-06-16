import { Router } from "express";
import { GoogleGenAI } from "@google/genai";

const router = Router();

const ATTEMPT_TIMEOUT_MS = 25_000;

function getServerKeys(): string[] {
  const candidates: (string | undefined)[] = [
    process.env["AI_INTEGRATIONS_GEMINI_API_KEY"],
    process.env["GEMINI_API_KEY"],
  ];
  for (let i = 2; i <= 20; i++) {
    candidates.push(process.env[`GEMINI_API_KEY_${i}`]);
  }
  const keys = candidates.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  return Array.from(new Set(keys.map((k) => k.trim())));
}

function getOpenRouterKeys(): string[] {
  const candidates: (string | undefined)[] = [
    process.env["AI_INTEGRATIONS_OPENROUTER_API_KEY"],
    process.env["OPENROUTER_API_KEY"],
    process.env["OPENROUTER_API_KEY_2"],
    process.env["OPENROUTER_API_KEY_3"],
  ];
  const keys = candidates.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  return Array.from(new Set(keys.map((k) => k.trim())));
}

function getOpenAIKeys(): string[] {
  const candidates: (string | undefined)[] = [
    process.env["OPENAI_API_KEY"],
    process.env["OPENAI_API_KEY_2"],
    process.env["OPENAI_API_KEY_3"],
  ];
  const keys = candidates.filter((k): k is string => typeof k === "string" && k.trim().length > 0);
  return Array.from(new Set(keys.map((k) => k.trim())));
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      const err: any = new Error(`${label} timeout after ${ms}ms`);
      err.code = "TIMEOUT";
      reject(err);
    }, ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

async function tryOpenAICompatible(
  baseUrl: string,
  apiKey: string,
  model: string,
  systemPrompt: string | undefined,
  messages: { role: string; content: string }[],
  signal: AbortSignal,
): Promise<string> {
  const body = {
    model,
    messages: [
      ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ],
    max_tokens: 2048,
  };
  const r = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": "https://my-dream-women.onrender.com",
      "X-Title": "My Dream Women Tamil AI Chat",
    },
    body: JSON.stringify(body),
    signal,
  });
  if (!r.ok) {
    const txt = await r.text();
    const err: any = new Error(`${r.status} ${txt.slice(0, 200)}`);
    err.status = r.status;
    throw err;
  }
  const json: any = await r.json();
  return json?.choices?.[0]?.message?.content ?? "பதில் இல்லை";
}

const MODELS = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"];

function isQuotaError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const status = err?.status ?? err?.statusCode ?? err?.code;
  return (
    status === 429 ||
    msg.includes("429") ||
    msg.includes("quota") ||
    msg.includes("exceeded") ||
    msg.includes("resource_exhausted") ||
    msg.includes("rate limit")
  );
}

function isKeyError(err: any): boolean {
  const msg = String(err?.message ?? err ?? "").toLowerCase();
  const status = err?.status ?? err?.statusCode ?? err?.code;
  if (status === 401 || status === 403) return true;
  return (
    msg.includes("api key not valid") ||
    msg.includes("api_key_invalid") ||
    msg.includes("permission_denied") ||
    msg.includes("unauthenticated") ||
    msg.includes("invalid api key")
  );
}

router.post("/chat", async (req, res) => {
  try {
    const { messages, systemPrompt, apiKey: clientApiKey } = req.body as {
      messages: { role: string; content: string }[];
      systemPrompt?: string;
      apiKey?: string;
    };

    if (!messages || messages.length === 0) {
      res.status(400).json({ error: "messages required" });
      return;
    }

    const serverKeys = getServerKeys();
    const tryKeys: string[] = [];
    if (clientApiKey?.trim()) tryKeys.push(clientApiKey.trim());
    for (const k of serverKeys) if (!tryKeys.includes(k)) tryKeys.push(k);

    // When client sends their own key → bypass Replit proxy → call Google directly
    // When no client key → use Replit AI Integration proxy as fallback
    const baseUrl = clientApiKey?.trim()
      ? undefined
      : process.env["AI_INTEGRATIONS_GEMINI_BASE_URL"];

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    let lastErr: any = null;
    let quotaErrCount = 0;
    let geminiAttempts = 0;

    for (let ki = 0; ki < tryKeys.length; ki++) {
      const key = tryKeys[ki];
      const ai = new GoogleGenAI({
        apiKey: key,
        ...(baseUrl ? { httpOptions: { apiVersion: "", baseUrl } } : {}),
      });

      for (const model of MODELS) {
        geminiAttempts++;
        try {
          const result = await withTimeout(
            ai.models.generateContent({
              model,
              contents,
              config: {
                maxOutputTokens: 8192,
                ...(systemPrompt ? { systemInstruction: systemPrompt } : {}),
              },
            }),
            ATTEMPT_TIMEOUT_MS,
            `gemini ${model}`,
          );
          const content = result.text ?? "பதில் இல்லை";
          req.log.info({ keyIdx: ki, model }, "Chat success");
          res.json({ content });
          return;
        } catch (err: any) {
          lastErr = err;
          const quota = isQuotaError(err);
          const keyBad = isKeyError(err);
          req.log.warn(
            { keyIdx: ki, model, quota, keyBad, msg: err?.message?.slice(0, 200) },
            "Chat attempt failed",
          );
          if (quota) {
            quotaErrCount++;
            continue;
          }
          if (keyBad) {
            break;
          }
          continue;
        }
      }
    }

    const orKeys = getOpenRouterKeys();
    const orModels = [
      "meta-llama/llama-3.1-8b-instruct:free",
      "google/gemma-2-9b-it:free",
      "mistralai/mistral-7b-instruct:free",
    ];
    for (const orKey of orKeys) {
      for (const orModel of orModels) {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
        try {
          const content = await tryOpenAICompatible(
            "https://openrouter.ai/api/v1",
            orKey,
            orModel,
            systemPrompt,
            messages,
            ctrl.signal,
          );
          clearTimeout(to);
          req.log.info({ provider: "openrouter", model: orModel }, "Chat success via fallback");
          res.json({ content });
          return;
        } catch (err: any) {
          clearTimeout(to);
          lastErr = err;
          if (isQuotaError(err)) quotaErrCount++;
          req.log.warn(
            { provider: "openrouter", model: orModel, msg: err?.message?.slice(0, 200) },
            "OpenRouter attempt failed",
          );
        }
      }
    }

    const oaKeys = getOpenAIKeys();
    for (const oaKey of oaKeys) {
      const ctrl = new AbortController();
      const to = setTimeout(() => ctrl.abort(), ATTEMPT_TIMEOUT_MS);
      try {
        const content = await tryOpenAICompatible(
          "https://api.openai.com/v1",
          oaKey,
          "gpt-4o-mini",
          systemPrompt,
          messages,
          ctrl.signal,
        );
        clearTimeout(to);
        req.log.info({ provider: "openai", model: "gpt-4o-mini" }, "Chat success via final fallback");
        res.json({ content });
        return;
      } catch (err: any) {
        clearTimeout(to);
        lastErr = err;
        if (isQuotaError(err)) quotaErrCount++;
        req.log.warn({ provider: "openai", msg: err?.message?.slice(0, 200) }, "OpenAI attempt failed");
      }
    }

    const noKeysAtAll = geminiAttempts === 0 && orKeys.length === 0 && oaKeys.length === 0;
    req.log.error(
      { lastErrMsg: lastErr?.message?.slice(0, 500), quotaErrCount, geminiAttempts, orKeys: orKeys.length, oaKeys: oaKeys.length },
      "All chat providers exhausted",
    );

    let friendly: string;
    let status: number;
    if (noKeysAtAll) {
      friendly = "⚙️ Server பிழை. சற்று நேரம் கழித்து மீண்டும் try பண்ணுங்க.";
      status = 503;
    } else if (quotaErrCount > 0) {
      friendly = "⏳ இன்னைக்கு server busy. நாளைக்கு மீண்டும் try பண்ணுங்க.";
      status = 429;
    } else if (isKeyError(lastErr)) {
      friendly = "🔑 API key valid இல்ல. Keys screen-ல check பண்ணுங்க.";
      status = 401;
    } else {
      friendly = "⚠️ பதில் வரல. கொஞ்ச நேரம் கழிச்சு try பண்ணுங்க.";
      status = 502;
    }
    res.status(status).json({ error: friendly });
  } catch (err: any) {
    req.log.error({ err: err?.message?.slice(0, 500), stack: err?.stack?.slice(0, 500) }, "Chat handler crashed");
    res.status(500).json({ error: "⚠️ Server error ஆச்சு. கொஞ்ச நேரம் கழிச்சு try பண்ணுங்க." });
  }
});

export default router;
