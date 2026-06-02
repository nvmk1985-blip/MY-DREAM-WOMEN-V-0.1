import { Router } from "express";
import { randomUUID } from "node:crypto";
import { Client } from "@gradio/client";

const router = Router();

interface Job {
  status: "processing" | "done" | "error" | "queue_wait" | "model_loading" | "cold_start" | "gpu_unavailable" | "sleeping" | "switching";
  result_url?: string;
  error?: string;
  user_message?: string;
  queue_position?: number;
  createdAt: number;
  retryCount?: number;
}
const jobs = new Map<string, Job>();

// Cleanup old jobs every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}, 10 * 60 * 1000);

function upd(jobId: string, data: Partial<Job>) {
  const j = jobs.get(jobId);
  if (j) jobs.set(jobId, { ...j, ...data });
}

router.get("/face-swap/ping", (_req, res) => res.json({ status: "ok", provider: "HuggingFace free" }));

router.get("/face-swap/result/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) { res.status(404).json({ error: "Job not found" }); return; }
  res.json(job);
});

router.post("/face-swap", async (req, res) => {
  const body = req.body as Record<string, string>;
  const hfToken = (req.headers["x-hf-token"] as string)?.trim() || undefined;

  // Accept both naming conventions
  const targetImg = body.target_url && body.face_url ? body.target_url : (body.source_url || body.target_url);
  const faceImg = body.face_url || body.target_url;

  if (!targetImg || !faceImg) {
    res.status(400).json({ error: "target_url (image where face goes) and face_url (source face photo) required" });
    return;
  }

  const jobId = randomUUID();
  jobs.set(jobId, { 
    status: "processing", 
    createdAt: Date.now(),
    user_message: "🔄 Preparing AI...",
    retryCount: 0
  });
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

function detectErrorType(error: any): { status: string; user_message: string; should_retry: boolean } {
  const msg = String(error?.message || error || "").toLowerCase();
  
  // Queue/Wait errors
  if (msg.includes("queue") || msg.includes("waiting")) {
    return { status: "queue_wait", user_message: "⏳ AI server busy. Waiting in queue...", should_retry: false };
  }
  
  // Model loading / Cold start
  if (msg.includes("loading") || msg.includes("cold") || msg.includes("503") || msg.includes("unavailable")) {
    return { status: "model_loading", user_message: "🚀 AI model starting. This may take 1-3 min...", should_retry: true };
  }
  
  // GPU unavailable
  if (msg.includes("gpu") || msg.includes("cuda")) {
    return { status: "gpu_unavailable", user_message: "⚡ No GPU. Retrying...", should_retry: true };
  }
  
  // Space sleeping / down
  if (msg.includes("sleep") || msg.includes("down") || msg.includes("404")) {
    return { status: "sleeping", user_message: "😴 Waking up AI server...", should_retry: true };
  }
  
  // Network errors
  if (msg.includes("network") || msg.includes("timeout") || msg.includes("fetch")) {
    return { status: "error", user_message: "🌐 Internet problem. Retrying...", should_retry: true };
  }
  
  // Rate limit
  if (msg.includes("429") || msg.includes("rate")) {
    return { status: "error", user_message: "⏱ Rate limited. Trying backup...", should_retry: true };
  }
  
  return { status: "error", user_message: "❌ Failed. Trying backup...", should_retry: true };
}

async function processSwap(jobId: string, targetUrl: string, faceUrl: string, hfToken?: string) {
  let retries = 0;
  const maxRetries = 10; // Up to 10 minutes with 5-second waits
  
  try {
    const [faceBlob, targetBlob] = await Promise.all([
      dataUriToBlob(faceUrl),
      dataUriToBlob(targetUrl),
    ]);

    const faceB64 = await faceBlob.arrayBuffer().then(b => Buffer.from(b).toString("base64"));
    const targetB64 = await targetBlob.arrayBuffer().then(b => Buffer.from(b).toString("base64"));
    const faceMime = (faceBlob.type || "image/jpeg");
    const targetMime = (targetBlob.type || "image/jpeg");
    const faceDataUri = `data:${faceMime};base64,${faceB64}`;
    const targetDataUri = `data:${targetMime};base64,${targetB64}`;

    let resultUrl: string | null = null;
    let lastError: any = null;

    // Primary providers (Gradio-based)
    const primarySpaces = [
      "tonyassi/face-swap",
      "Dentro/face-swap",
      "felixrosberg/face-swap",
    ];

    // Backup providers (REST-based)
    const backupSpaces = [
      "blackhool-roop-face-swap",
      "deepfuture-ai-faceswap",
    ];

    // Try primary providers first
    for (const space of primarySpaces) {
      if (resultUrl) break;
      try {
        upd(jobId, { 
          user_message: `🔄 Processing with ${space.split('/')[1]}...`,
          status: "processing"
        });
        resultUrl = await tryGradioSpace(space, faceBlob, targetBlob, 120000, hfToken);
      } catch (e: any) {
        lastError = e;
        const errorInfo = detectErrorType(e);
        upd(jobId, { 
          user_message: errorInfo.user_message,
          status: errorInfo.status as any
        });
        console.error(`[faceswap] ${space} failed:`, e?.message?.slice(0, 100));
        
        if (errorInfo.should_retry && retries < maxRetries) {
          retries++;
          await new Promise(r => setTimeout(r, 5000)); // 5 second wait before retry
        }
      }
    }

    // Try backup providers if primary failed
    if (!resultUrl) {
      upd(jobId, { 
        user_message: "🔄 Switching to backup service...",
        status: "switching"
      });
      
      for (const space of backupSpaces) {
        if (resultUrl) break;
        try {
          upd(jobId, { 
            user_message: `🔄 Using backup: ${space}...`,
            status: "processing"
          });
          resultUrl = await tryRestSpace(space, faceDataUri, targetDataUri, hfToken);
        } catch (e: any) {
          lastError = e;
          console.error(`[faceswap] ${space} failed:`, e?.message?.slice(0, 100));
        }
      }
    }

    // Success!
    if (resultUrl) {
      upd(jobId, { 
        status: "done", 
        result_url: resultUrl,
        user_message: "✅ Face swap complete!"
      });
      return;
    }

    // All providers exhausted
    const startTime = jobs.get(jobId)?.createdAt || Date.now();
    const elapsedMs = Date.now() - startTime;
    
    if (elapsedMs > 10 * 60 * 1000) {
      // 10 minutes timeout
      upd(jobId, {
        status: "error",
        error: "Timeout after 10 minutes",
        user_message: "⏱ Service timeout. Try again later.",
      });
    } else {
      upd(jobId, {
        status: "error",
        error: lastError?.message || "All providers failed",
        user_message: "😕 Services unavailable. Try in a few minutes.",
      });
    }
    
  } catch (err: any) {
    const errorInfo = detectErrorType(err);
    upd(jobId, { 
      status: "error", 
      error: err?.message || "Face swap failed",
      user_message: errorInfo.user_message
    });
    console.error("[faceswap] fatal error:", err?.message);
  }
}

export default router;
