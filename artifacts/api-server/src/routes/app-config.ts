import { Router } from "express";

const router = Router();

router.get("/app-config", (_req, res) => {
  res.json({
    githubToken: process.env["GITHUB_KEY"] || null,
    hfToken: process.env["HF_TOKEN"] || null,
    defaultServerUrl: "https://my-dream-women.onrender.com",
  });
});

export default router;
