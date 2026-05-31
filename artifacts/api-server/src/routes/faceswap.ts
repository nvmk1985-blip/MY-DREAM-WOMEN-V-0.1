import { Router } from "express";
import { randomUUID } from "node:crypto";
import { Client } from "@gradio/client";

const router = Router();

interface Job {
  status: "processing" | "done" | "error";
  result_url?: string;
  error?: string;
  createdAt: number;
}
const jobs = new Map<string, Job>();

setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
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

router.post("/face-swap", async (req, res) => {
  const body = req.body as Record<string, string>;
  // x-hf-token: user's HuggingFace API token for authenticated space access
  const hfToken = (req.headers["x-hf-token"] as string)?.trim() || undefined;

  // Accept both naming conventions:
  // New (face-swap.tsx v2): { target_url: where-face-goes, face_url: source-face }
  // Old (legacy):           { source_url: where-face-goes, target_url: source-face }
  const targetImg = body.target_url && body.face_url ? body.target_url : (body.source_url || body.target_url);
  const faceImg   = body.face_url || body.target_url;

  if (!targetImg || !faceImg) {
    res.status(400).json({ error: "target_url (image where face goes) and face_url (source face photo) required" });
    return;
  }

  const jobId = randomUUID();
  jobs.set(jobId, { status: "processing", createdAt: Date.now() });
  res.json({ jobId });
  processSwap(jobId, targetImg, faceImg, hfToken).catch(() => {});
});

async function dataUriToBlob(url: string): Promise<Blob> {
  if (url.startsWith("data:")) {
    const m = url.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) throw new Error("Invalid data URI");
    const bytes = Buffer.from(m[2], "base64");
    return new Blob([bytes], { type: m[1] });
  }
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`fetch failed ${r.status}`);
  const buf = await r.arrayBuffer();
  return new Blob([buf], { type: r.headers.get("content-type") || "image/jpeg" });
}

// Try a Gradio space using @gradio/client SDK
async function tryGradioSpace(
  spaceName: string,
  faceBlob: Blob,
  targetBlob: Blob,
  timeoutMs = 120000,
  hfToken?: string,
): Promise<string | null> {
  const timer = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error(`${spaceName} timeout`)), timeoutMs),
  );
  const run = (async () => {
    const opts: any = {};
    if (hfToken) opts.hf_token = hfToken;
    const client = await Client.connect(spaceName, opts);
    // tonyassi/face-swap expects [source_face_blob, target_image_blob]
    const result = await client.predict("/predict", [faceBlob, targetBlob]) as any;
    const out = result?.data?.[0];
    if (!out) return null;
    if (typeof out === "string" && (out.startsWith("http") || out.startsWith("data:"))) return out;
    if (out?.url) return out.url as string;
    if (out?.path) {
      const host = spaceName.toLowerCase().replace("/", "-");
      return `https://${host}.hf.space/file=${out.path}`;
    }
    return null;
  })();
  return Promise.race([run, timer]);
}

// Fallback: raw REST for spaces that still support /run/predict
async function tryRestSpace(
  spaceHost: string,
  faceB64: string,
  targetB64: string,
  hfToken?: string,
): Promise<string | null> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (hfToken) headers["Authorization"] = `Bearer ${hfToken}`;
  const res = await fetch(`https://${spaceHost}.hf.space/run/predict`, {
    method: "POST",
    headers,
    body: JSON.stringify({ data: [faceB64, targetB64], fn_index: 0 }),
    signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) return null;
  const json = await res.json() as any;
  const out = json?.data?.[0];
  if (!out) return null;
  if (typeof out === "string" && (out.startsWith("http") || out.startsWith("data:"))) return out;
  if (out?.url) return out.url as string;
  if (out?.path) return `https://${spaceHost}.hf.space/file=${out.path}`;
  return null;
}

async function processSwap(jobId: string, targetUrl: string, faceUrl: string, hfToken?: string) {
  try {
    // Both images come as base64 data URIs from mobile app (no external URL fetching!)
    const [faceBlob, targetBlob] = await Promise.all([
      dataUriToBlob(faceUrl),
      dataUriToBlob(targetUrl),
    ]);

    // Convert to base64 for REST fallback
    const faceB64 = await faceBlob.arrayBuffer().then(b => Buffer.from(b).toString("base64"));
    const targetB64 = await targetBlob.arrayBuffer().then(b => Buffer.from(b).toString("base64"));
    const faceMime = (faceBlob.type || "image/jpeg");
    const targetMime = (targetBlob.type || "image/jpeg");
    const faceDataUri = `data:${faceMime};base64,${faceB64}`;
    const targetDataUri = `data:${targetMime};base64,${targetB64}`;

    let resultUrl: string | null = null;

    // 1. tonyassi/face-swap (most reliable free HF space, insightface)
    if (!resultUrl) {
      try {
        resultUrl = await tryGradioSpace("tonyassi/face-swap", faceBlob, targetBlob, 120000, hfToken);
      } catch (e: any) { console.error("[faceswap] tonyassi failed:", e?.message?.slice(0, 100)); }
    }

    // 2. Dentro/face-swap
    if (!resultUrl) {
      try {
        resultUrl = await tryGradioSpace("Dentro/face-swap", faceBlob, targetBlob, 90000, hfToken);
      } catch (e: any) { console.error("[faceswap] Dentro failed:", e?.message?.slice(0, 100)); }
    }

    // 3. felixrosberg/face-swap
    if (!resultUrl) {
      try {
        resultUrl = await tryGradioSpace("felixrosberg/face-swap", faceBlob, targetBlob, 90000, hfToken);
      } catch (e: any) { console.error("[faceswap] felixrosberg failed:", e?.message?.slice(0, 100)); }
    }

    // 4. Raw REST fallback (blackhool roop)
    if (!resultUrl) {
      try {
        resultUrl = await tryRestSpace("blackhool-roop-face-swap", faceDataUri, targetDataUri, hfToken);
      } catch (e: any) { console.error("[faceswap] blackhool REST failed:", e?.message?.slice(0, 100)); }
    }

    if (resultUrl) {
      upd(jobId, { status: "done", result_url: resultUrl });
    } else {
      upd(jobId, {
        status: "error",
        error: "Face swap இப்போது கிடைக்கவில்லை. HuggingFace spaces sleeping ஆகியிருக்கலாம். சில நிமிடம் கழித்து மீண்டும் try பண்ணுங்க.",
      });
    }
  } catch (err: any) {
    upd(jobId, { status: "error", error: err?.message || "Face swap failed" });
  }
}

export default router;
