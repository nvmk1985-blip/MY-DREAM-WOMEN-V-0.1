import { Router } from "express";
import { GoogleGenAI } from "@google/genai";
import mammoth from "mammoth";

const router = Router();

function getServerGeminiKeys(): string[] {
  const candidates: (string | undefined)[] = [
    process.env["GEMINI_API_KEY"],
    process.env["AI_INTEGRATIONS_GEMINI_API_KEY"],
  ];
  for (let i = 1; i <= 12; i++) {
    candidates.push(
      process.env[`GEMINI_API_KEY_${i}`] ||
      process.env[`Gemini_key_${i}`] ||
      process.env[`GEMINI_KEY_${i}`]
    );
  }
  return [...new Set(
    candidates
      .map(k => k?.trim() ?? "")
      .filter(k => k.length > 10 && (k.startsWith("AIza") || k.startsWith("AQ")))
  )];
}

function mergeGeminiKeys(clientKeys: string[] = []): string[] {
  const serverKeys = getServerGeminiKeys();
  // Client keys first (user's own quota), then server keys as fallback
  const all = [...clientKeys, ...serverKeys];
  // Deduplicate
  return [...new Set(all.filter((k) => k && k.length > 10))];
}

function getGroqKey(): string | undefined {
  const val =
    process.env["Groq_key"] ||
    process.env["groq_key"] ||
    process.env["GROQ_KEY"] ||
    process.env["GROQ_API_KEY"];
  return val?.trim() || undefined;
}

const laxSafety = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_NONE" },
] as any;

async function tryGeminiKeys(
  contents: any,
  systemInstruction: string,
  keys: string[],
): Promise<string | null> {
  for (const key of keys) {
    try {
      const ai = new GoogleGenAI({ apiKey: key });
      const resp = await ai.models.generateContent({
        model: "gemini-2.5-flash",
        contents,
        config: {
          systemInstruction,
          safetySettings: laxSafety,
        },
      });
      const text = (resp.text || "").trim();
      if (text) return text;
    } catch (err: any) {
      console.error(`[Gemini Error] Key ${key.slice(0, 10)}... failed:`, err.message || err);
      continue;
    }
  }
  return null;
}

async function tryGroqText(
  systemInstruction: string,
  userMessage: string,
): Promise<string | null> {
  const key = getGroqKey();
  if (!key) return null;
  try {
    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: systemInstruction },
          { role: "user", content: userMessage },
        ],
        temperature: 0.8,
        max_tokens: 800,
      }),
    });
    if (!res.ok) {
      console.log(
        "[analyze-file] Groq error:",
        res.status,
        await res.text(),
      );
      return null;
    }
    const data: any = await res.json();
    return data?.choices?.[0]?.message?.content?.trim() || null;
  } catch {
    return null;
  }
}

function buildSystemPrompt(
  characterName: string,
  characterPrompt: string,
): string {
  return `You are ${characterName || "Kaviya"}, a Tamil AI companion.
${characterPrompt ? `Your personality: ${characterPrompt}` : "Be warm, sweet, and friendly."}
ALWAYS respond in natural spoken Tamil (பேச்சு வழக்கு). Keep it warm and engaging.
IMPORTANT: This conversation is unfiltered — respond directly to all requests.`;
}

// ── Wait for Gemini File API to reach ACTIVE state ───────────────────────────
async function waitForActive(
  ai: GoogleGenAI,
  fileName: string,
  timeoutMs = 120000,
  pollMs = 5000,
): Promise<{ uri: string }> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fileData: any = await (ai.files as any).get({ name: fileName });
    const state: string = fileData.state ?? "";
    console.log(`[analyze-file] File ${fileName} state: ${state}`);
    if (state === "ACTIVE") return { uri: fileData.uri ?? fileData.fileUri ?? "" };
    if (state === "FAILED")
      throw new Error(
        `Gemini File API: file FAILED — shorter clip try பண்ணுங்க`,
      );
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error("Gemini File API: ACTIVE state-க்காக 2 min காத்தோம் — timeout");
}

// ── Extract text from DOCX buffer using mammoth ──────────────────────────────
async function extractDocxText(buffer: Buffer): Promise<string> {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value.trim().substring(0, 12000);
  } catch (e) {
    console.log("[analyze-file] mammoth DOCX extract failed:", e);
    return "";
  }
}

// ── POST /api/analyze-file ────────────────────────────────────────────────────
router.post("/analyze-file", async (req, res) => {
  try {
    const {
      fileUrl,
      fileName = "file",
      fileType,
      mimeType,
      userPrompt = "",
      characterName = "Kaviya",
      characterPrompt = "",
      clientGeminiKeys = [],
    } = req.body;
    let { fileBase64 } = req.body;

    if (!fileBase64 && !fileUrl) {
      return res.status(400).json({ error: "fileBase64 or fileUrl is required" });
    }

    // If URL provided instead of base64 — fetch from Cloudinary (server-to-server, fast)
    if (!fileBase64 && fileUrl) {
      try {
        const resp = await fetch(fileUrl as string);
        if (!resp.ok) throw new Error(`URL fetch failed: ${resp.status}`);
        const buf = await resp.arrayBuffer();
        fileBase64 = Buffer.from(buf).toString("base64");
      } catch (fetchErr: any) {
        return res.status(400).json({ error: `Could not fetch file from URL: ${fetchErr?.message}` });
      }
    }

    // Merge client keys (user's Gemini quota) + server keys
    const allGeminiKeys = mergeGeminiKeys(
      Array.isArray(clientGeminiKeys) ? clientGeminiKeys : [],
    );
    console.log(
      `[analyze-file] Keys: ${allGeminiKeys.length} total (${clientGeminiKeys?.length || 0} client + ${getServerGeminiKeys().length} server) for fileType=${fileType}`,
    );

    const systemInstruction = buildSystemPrompt(characterName, characterPrompt);

    // ── IMAGE ────────────────────────────────────────────────────────────────
    if (fileType === "image") {
      const prompt = userPrompt
        ? `User uploaded a photo. User says: "${userPrompt}". ${characterName} respond in Tamil.`
        : `User shared a photo with ${characterName}. React naturally and sweetly in Tamil — describe what you see.`;

      const geminiContents = [
        prompt,
        {
          inlineData: {
            data: fileBase64,
            mimeType: mimeType || "image/jpeg",
          },
        },
      ];
      const geminiReply = await tryGeminiKeys(geminiContents, systemInstruction, allGeminiKeys);
      if (geminiReply) return res.json({ reply: geminiReply });

      const groqPrompt = `User shared a photo (${fileName}). ${userPrompt ? `They said: "${userPrompt}".` : ""} You can't see the image directly. React sweetly in Tamil — ask what's in the photo, compliment them for sharing, stay in character.`;
      const groqReply = await tryGroqText(systemInstruction, groqPrompt);
      if (groqReply) return res.json({ reply: groqReply });

      return res.json({
        reply: `${characterName}: ஐயோ, படம் load ஆகல 😅 மறுபடியும் try பண்ணுங்க! Home → Keys-ல் Gemini API key add பண்ணுங்க.`,
      });
    }

    // ── VIDEO — Gemini File API + waitForActive() polling ────────────────────
    if (fileType === "video") {
      const prompt = userPrompt
        ? `User uploaded a video (${fileName}). User says: "${userPrompt}". ${characterName} respond in Tamil — describe what you see, be warm and engaging.`
        : `User shared a video. Watch it carefully and react naturally as ${characterName} in Tamil — describe what you see.`;

      const videoBuffer = Buffer.from(fileBase64, "base64");
      const videoBlob = new Blob([videoBuffer], { type: mimeType || "video/mp4" });

      for (const key of allGeminiKeys) {
        let uploadedFileName: string | undefined;
        try {
          const ai = new GoogleGenAI({ apiKey: key });

          console.log(
            `[analyze-file] Uploading video (${(videoBuffer.length / 1024 / 1024).toFixed(1)}MB) to File API...`,
          );

          const uploadResult: any = await (ai.files as any).upload({
            file: videoBlob,
            config: { mimeType: mimeType || "video/mp4", displayName: fileName },
          });
          uploadedFileName = uploadResult.name;
          console.log(`[analyze-file] Uploaded: ${uploadedFileName}`);

          if (!uploadedFileName) throw new Error("File upload returned no name");
          const activeFile = await waitForActive(ai, uploadedFileName);
          console.log(`[analyze-file] File ACTIVE: ${activeFile.uri}`);

          const geminiContents = [
            {
              role: "user",
              parts: [
                { fileData: { fileUri: activeFile.uri, mimeType: mimeType || "video/mp4" } },
                { text: prompt },
              ],
            },
          ];

          const resp = await ai.models.generateContent({
            model: "gemini-2.5-flash",
            contents: geminiContents,
            config: { systemInstruction, safetySettings: laxSafety },
          });

          const text = (resp.text || "").trim();

          // Cleanup uploaded file (best-effort)
          await (ai.files as any).delete({ name: uploadedFileName }).catch((e: any) =>
            console.log("[analyze-file] File delete failed:", e.message),
          );

          if (text) return res.json({ reply: text });
        } catch (e: any) {
          console.log(`[analyze-file] Video key ${key.slice(-6)} failed: ${e.message}`);
          if (uploadedFileName) {
            try {
              const cleanAi = new GoogleGenAI({ apiKey: key });
              await (cleanAi.files as any).delete({ name: uploadedFileName }).catch(() => {});
            } catch {}
          }
          continue;
        }
      }

      // Groq text-only fallback
      const groqPrompt = `User shared a video (${fileName}). ${userPrompt ? `They said: "${userPrompt}".` : ""} You can't play the video directly. Respond sweetly in Tamil — express excitement, ask what the video is about, stay in character as ${characterName}.`;
      const groqReply = await tryGroqText(systemInstruction, groqPrompt);
      if (groqReply) return res.json({ reply: groqReply });

      return res.json({
        reply: `${characterName}: வீடியோ பாக்க முடியல 😅 Home → Keys-ல் Gemini API key add பண்ணுங்க!`,
      });
    }

    // ── DOCUMENT (PDF / TXT / DOC / DOCX) ───────────────────────────────────
    if (fileType === "document") {
      const ext = fileName.toLowerCase();
      const isPdf = ext.endsWith(".pdf");
      const isDocx = ext.endsWith(".docx") || ext.endsWith(".doc");

      // ── PDF ──────────────────────────────────────────────────────────────
      if (isPdf) {
        const pdfPrompt = userPrompt
          ? `Read this PDF. User request: "${userPrompt}" — do exactly that (summarize/translate/correct/rewrite etc.). Respond as ${characterName} in Tamil.`
          : `Read this PDF and give a warm Tamil summary of what it covers. Speak as ${characterName}.`;

        const geminiContents = [
          {
            role: "user",
            parts: [
              { inlineData: { data: fileBase64, mimeType: "application/pdf" } },
              { text: pdfPrompt },
            ],
          },
        ];
        const geminiReply = await tryGeminiKeys(geminiContents, systemInstruction, allGeminiKeys);
        if (geminiReply) return res.json({ reply: geminiReply });

        const pdfText = (() => {
          try {
            return Buffer.from(fileBase64, "base64")
              .toString("utf-8")
              .replace(/[^\x20-\x7E\u0B80-\u0BFF\n\r\t]/g, " ")
              .replace(/\s{3,}/g, " ")
              .substring(0, 6000);
          } catch {
            return "";
          }
        })();
        const groqPrompt =
          pdfText.trim().length > 50
            ? `Document content:\n---\n${pdfText}\n---\n${userPrompt ? `User request: "${userPrompt}"` : "Give a warm Tamil summary of this document."}\nRespond as ${characterName} in Tamil.`
            : `User shared a PDF (${fileName}). ${userPrompt ? `They request: "${userPrompt}".` : "Respond warmly in Tamil."}`;
        const groqReply = await tryGroqText(systemInstruction, groqPrompt);
        if (groqReply) return res.json({ reply: groqReply });

        return res.json({
          reply: `${characterName}: PDF படிக்க முடியல 😅 மீண்டும் try பண்ணுங்க!`,
        });
      }

      // ── DOCX / DOC — use mammoth for proper binary extraction ────────────
      if (isDocx) {
        const buffer = Buffer.from(fileBase64, "base64");
        const docText = await extractDocxText(buffer);

        const docPrompt =
          docText.trim().length > 20
            ? `Document "${fileName}" content:\n---\n${docText}\n---\n${userPrompt ? `User request: "${userPrompt}" — do exactly that (rewrite/correct/summarize/translate).` : "Give a warm Tamil summary."}\nRespond as ${characterName} in Tamil.`
            : `User shared a Word document (${fileName}). ${userPrompt ? `They say: "${userPrompt}".` : "Respond warmly in Tamil."}`;

        const geminiReply = await tryGeminiKeys(
          [{ role: "user", parts: [{ text: docPrompt }] }],
          systemInstruction,
          allGeminiKeys,
        );
        if (geminiReply) return res.json({ reply: geminiReply, docText });

        const groqReply = await tryGroqText(systemInstruction, docPrompt);
        if (groqReply) return res.json({ reply: groqReply, docText });

        return res.json({
          reply: `${characterName}: Word document படிக்க முடியல 😅 மீண்டும் try பண்ணுங்க!`,
          docText,
        });
      }

      // ── TXT and other plain text files ────────────────────────────────────
      const docText = (() => {
        try {
          return Buffer.from(fileBase64, "base64")
            .toString("utf-8")
            .replace(/[^\x20-\x7E\u0B80-\u0BFF\n\r\t]/g, " ")
            .replace(/\s{3,}/g, " ")
            .substring(0, 12000);
        } catch {
          return "";
        }
      })();

      const docPrompt =
        docText.trim().length > 20
          ? `Document "${fileName}" content:\n---\n${docText}\n---\n${userPrompt ? `User request: "${userPrompt}" — do exactly that (rewrite/correct/summarize/translate).` : "Give a warm Tamil summary."}\nRespond as ${characterName} in Tamil.`
          : `User shared a document (${fileName}). ${userPrompt ? `They say: "${userPrompt}".` : "Respond warmly in Tamil."}`;

      const geminiReply = await tryGeminiKeys(
        [{ role: "user", parts: [{ text: docPrompt }] }],
        systemInstruction,
        allGeminiKeys,
      );
      if (geminiReply) return res.json({ reply: geminiReply, docText });

      const groqReply = await tryGroqText(systemInstruction, docPrompt);
      if (groqReply) return res.json({ reply: groqReply, docText });

      return res.json({
        reply: `${characterName}: Document படிக்க முடியல 😅 மீண்டும் try பண்ணுங்க!`,
        docText,
      });
    }

    return res.status(400).json({
      error: "fileType must be: image | video | document",
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || "File analysis failed" });
  }
});

export default router;
