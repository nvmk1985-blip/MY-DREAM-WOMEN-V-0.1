import { Router } from "express";

const router = Router();

router.get("/app-config", (_req, res) => {
  const baseGemini =
    process.env["GEMINI_API_KEY"] ||
    process.env["AI_INTEGRATIONS_GEMINI_API_KEY"] ||
    "";
  const geminiKeys: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const slotKey = process.env[`GEMINI_API_KEY_${i}`] || "";
    geminiKeys.push(slotKey || (i === 1 ? baseGemini : ""));
  }
  if (!geminiKeys[0] && baseGemini) geminiKeys[0] = baseGemini;

  res.json({
    githubToken: process.env["GITHUB_KEY"] || null,
    hfToken: process.env["HUGGING_FACE_KEY"] || null,
    openrouterKey: process.env["OPENROUTER_API_KEY"] || null,
    groqKey: process.env["GROQ_KEY"] || null,
    cloudinary: {
      cloudName:  process.env["CLOUDINARY_CLOUD_NAME"] || null,
      apiKey:     process.env["API_KEY"] || null,
      apiSecret:  process.env["API_SECRET"] || null,
    },
    geminiKeys,
    defaultServerUrl: "https://my-dream-women.onrender.com",
  });
});

export default router;
