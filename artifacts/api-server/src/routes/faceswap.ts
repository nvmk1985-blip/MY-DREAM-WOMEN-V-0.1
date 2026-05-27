import { Router } from "express";
import { randomUUID } from "node:crypto";

const router = Router();

interface Job {
  status: "processing" | "done" | "error";
  result_url?: string;
  error?: string;
  createdAt: number;
  aiTaskId?: string;
}
const jobs = new Map<string, Job>();
const aiTaskToJob = new Map<string, string>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) {
    if (j.createdAt < cutoff) { if (j.aiTaskId) aiTaskToJob.delete(j.aiTaskId); jobs.delete(id); }
  }
}, 10 * 60 * 1000);

function upd(jobId: string, data: Partial<Job>) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, ...data });
}

router.get("/face-swap/ping", (_req, res) => res.json({ status: "ok" }));

router.get("/face-swap/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

router.post("/face-swap/webhook", (req, res) => {
  res.json({ received: true });
  const { task_id, image_url } = req.body as { task_id?: string; image_url?: string };
  if (!task_id) return;
  const jobId = aiTaskToJob.get(task_id);
  if (!jobId) return;
  if (image_url) { upd(jobId, { status: "done", result_url: image_url }); aiTaskToJob.delete(task_id); }
  else { upd(jobId, { status: "error", error: "Swap failed." }); }
});

router.post("/face-swap", async (req, res) => {
  // source_url = preset body image URL; target_url = user selfie base64
  const { source_url, target_url } = req.body as { source_url: string; target_url: string };
  if (!source_url || !target_url) { res.status(400).json({ error: "source_url and target_url required" }); return; }
  const jobId = randomUUID();
  jobs.set(jobId, { status: "processing", createdAt: Date.now() });
  res.json({ jobId });
  processSwap(jobId, source_url, target_url).catch(() => {});
});

// ── Helpers ────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

async function toDataUri(url: string): Promise<string> {
  if (url.startsWith("data:")) return url;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`fetch ${res.status}`);
  const buf = await res.arrayBuffer();
  const mime = (res.headers.get("content-type") || "image/jpeg").split(";")[0];
  return `data:${mime};base64,${Buffer.from(buf).toString("base64")}`;
}

async function toBase64Only(url: string): Promise<{ b64: string; mime: string }> {
  const uri = await toDataUri(url);
  const match = uri.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) throw new Error("base64 parse failed");
  return { b64: match[2], mime: match[1] };
}

// ── 1. aifaceswap.io ─────────────────────────────────────────────
async function tryAiFaceSwap(jobId: string, bodyUrl: string, faceB64: string): Promise<boolean> {
  const key = process.env["AIFACESWAP_KEY"];
  if (!key) return false;
  const domain = (process.env["REPLIT_DOMAINS"] || "").split(",")[0].trim();
  const wh = domain ? `https://${domain}/api/face-swap/webhook` : "";
  const body: Record<string, string> = { source_image: bodyUrl, face_image: faceB64 };
  if (wh) body["webhook"] = wh;
  const res = await fetch("https://aifaceswap.io/api/aifaceswap/v1/faceswap", {
    method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json() as any;
  if (!res.ok || data?.code !== 200) throw new Error(data?.message || `aifaceswap ${res.status}`);
  const aiTaskId: string = data?.data?.task_id;
  if (!aiTaskId) throw new Error("No task_id");
  upd(jobId, { aiTaskId });
  aiTaskToJob.set(aiTaskId, jobId);
  if (!wh) { await sleep(60000); const j = jobs.get(jobId); if (j?.status === "processing") upd(jobId, { status: "error", error: "Timeout. மீண்டும் try பண்ணுங்க." }); }
  return true;
}

// ── 2. Replicate (face-swap model) ──────────────────────────────
async function tryReplicate(bodyUrl: string, faceUrl: string): Promise<string | null> {
  const key = process.env["REPLICATE_API_TOKEN"];
  if (!key) return null;
  // Use face-to-many or inswapper model
  const models = [
    { version: "9a4f3b32f6b32c3c5e67e9cd6bd62ef3a1d5d1c7e7b5e0f5d6e8a9b2c3d4e5f", input: { target_image: bodyUrl, source_image: faceUrl } },
  ];
  for (const m of models) {
    try {
      const res = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { Authorization: `Token ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify(m),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const pred = await res.json() as any;
      const pollUrl = pred?.urls?.get;
      if (!pollUrl) continue;
      // Poll for result
      for (let i = 0; i < 30; i++) {
        await sleep(4000);
        const r2 = await fetch(pollUrl, { headers: { Authorization: `Token ${key}` }, signal: AbortSignal.timeout(10000) });
        if (!r2.ok) break;
        const d2 = await r2.json() as any;
        if (d2?.status === "succeeded") return Array.isArray(d2.output) ? d2.output[0] : d2.output;
        if (d2?.status === "failed") break;
      }
    } catch { continue; }
  }
  return null;
}

// ── 3. fal.ai ────────────────────────────────────────────────────
async function tryFal(bodyUrl: string, faceUrl: string): Promise<string | null> {
  const key = process.env["FAL_KEY"];
  if (!key) return null;
  const res = await fetch("https://fal.run/fal-ai/face-swap", {
    method: "POST",
    headers: { Authorization: `Key ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ source_image_url: bodyUrl, target_image_url: faceUrl }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return null;
  const d = await res.json() as any;
  return d?.image?.url ?? d?.images?.[0]?.url ?? null;
}

// ── 4. HuggingFace Gradio spaces (no key needed) ─────────────────
async function gradioPredict(slug: string, ep: string, data: unknown[]): Promise<string | null> {
  const res = await fetch(`https://${slug}.hf.space/run/${ep}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) throw new Error(`${slug} HTTP ${res.status}`);
  const json = await res.json() as any;
  const raw = json?.data?.[0];
  if (!raw) return null;
  if (typeof raw === "string" && (raw.startsWith("http") || raw.startsWith("data:"))) return raw;
  if (raw?.url) return raw.url as string;
  if (raw?.path) return `https://${slug}.hf.space/file=${raw.path}`;
  return null;
}

async function tryHuggingFaceSpaces(bodyB64: string, faceB64: string): Promise<string | null> {
  // Spaces: [slug, endpoint, data order = [face, body] or [body, face]]
  const spaces: Array<{ slug: string; ep: string; data: unknown[] }> = [
    { slug: "tonyassi-face-swap",     ep: "run_inference", data: [faceB64, bodyB64] },
    { slug: "Dentro-face-swap",       ep: "predict",       data: [faceB64, bodyB64] },
    { slug: "felixrosberg-face-swap", ep: "predict",       data: [faceB64, bodyB64] },
    { slug: "Reubend-face-swap",      ep: "predict",       data: [faceB64, bodyB64] },
    { slug: "iakarslan-face-swap",    ep: "predict",       data: [faceB64, bodyB64] },
  ];
  for (const s of spaces) {
    try {
      const url = await gradioPredict(s.slug, s.ep, s.data);
      if (url) return url;
    } catch { continue; }
  }
  return null;
}

// ── Main ─────────────────────────────────────────────────────────
async function processSwap(jobId: string, bodyUrl: string, faceB64: string) {
  // 1. aifaceswap.io
  try { if (await tryAiFaceSwap(jobId, bodyUrl, faceB64)) return; } catch { /* no key */ }

  // 2. Replicate
  try {
    const url = await tryReplicate(bodyUrl, faceB64);
    if (url) { upd(jobId, { status: "done", result_url: url }); return; }
  } catch { /* no key */ }

  // 3. fal.ai
  try {
    const url = await tryFal(bodyUrl, faceB64);
    if (url) { upd(jobId, { status: "done", result_url: url }); return; }
  } catch { /* no credits */ }

  // 4. HuggingFace spaces (free, no key)
  try {
    let bodyB64: string, faceB64clean: string;
    [bodyB64, faceB64clean] = await Promise.all([
      toDataUri(bodyUrl),
      faceB64, // already base64 data uri
    ]);
    const url = await tryHuggingFaceSpaces(bodyB64, faceB64clean);
    if (url) { upd(jobId, { status: "done", result_url: url }); return; }
  } catch { /* spaces offline */ }

  upd(jobId, {
    status: "error",
    error: "Face swap தற்போது கிடைக்கவில்லை. AIFACESWAP_KEY அல்லது FAL_KEY சேர்த்தால் work ஆகும்.",
  });
}

export default router;
