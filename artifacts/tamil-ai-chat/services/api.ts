// APK-ல் absolute URL வேணும் — EXPO_PUBLIC_API_URL set பண்ணுங்க
// Web/dev-ல் empty string → relative URL (proxy works automatically)
const REPLIT_API: string = (process.env['EXPO_PUBLIC_API_URL'] ?? '').replace(/\/$/, '');

// Local Gemma server (OpenAI-compatible format — PocketPal AI, Jan, llama.cpp etc.)
export async function sendToLocalGemma(
  port: string,
  messages: { role: string; content: string }[],
  systemPrompt?: string,
): Promise<string> {
  const body: any = {
    model: 'gemma',
    messages: [
      ...(systemPrompt ? [{ role: 'system', content: systemPrompt }] : []),
      ...messages.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content })),
    ],
    max_tokens: 512,
    temperature: 0.8,
    stream: false,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(`http://localhost:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Local Gemma: HTTP ${res.status}`);
    const data = await res.json() as any;
    return data?.choices?.[0]?.message?.content?.trim() || 'பதில் இல்லை';
  } finally {
    clearTimeout(timer);
  }
}

export interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: Date;
  imageUrl?: string;
  imageLoading?: boolean;
  galleryUrls?: string[];
  galleryLabel?: string;
}

// ── Gemini key rotation helper ─────────────────────────────────
// Loads all gemini_1..gemini_13 keys that are enabled, rotates
// through them round-robin, returns the active key (or undefined).
async function getRotatingGeminiKey(): Promise<string | undefined> {
  try {
    const AS = (await import('@react-native-async-storage/async-storage')).default;
    const [saved, enabledRaw, idxRaw] = await Promise.all([
      AS.getItem('api_keys_store'),
      AS.getItem('api_keys_enabled_v1'),
      AS.getItem('gemini_key_rotation_idx'),
    ]);
    if (!saved) return undefined;
    const parsed = JSON.parse(saved) as Record<string, string>;
    const enabled = enabledRaw ? (JSON.parse(enabledRaw) as Record<string, boolean>) : {};

    // Collect all active Gemini keys (slots 1–13)
    const activeKeys: string[] = [];
    for (let i = 1; i <= 13; i++) {
      const k = parsed[`gemini_${i}`];
      if (k?.trim() && enabled[`gemini_${i}`]) activeKeys.push(k.trim());
    }
    if (activeKeys.length === 0) return undefined;

    // Pick current slot and advance index
    const idx = parseInt(idxRaw || '0', 10);
    const key = activeKeys[idx % activeKeys.length];
    const nextIdx = (idx + 1) % activeKeys.length;
    await AS.setItem('gemini_key_rotation_idx', String(nextIdx));
    return key;
  } catch { return undefined; }
}

export async function sendMessage(
  messages: { role: string; content: string }[],
  _provider: string = 'gemini',
  systemPrompt?: string,
): Promise<string> {
  const trimmed = messages.slice(-10);

  // Get rotating Gemini key (13-slot round-robin)
  const apiKey = await getRotatingGeminiKey();

  // Try up to all active keys before giving up
  const AS = (await import('@react-native-async-storage/async-storage')).default;
  const [saved, enabledRaw] = await Promise.all([
    AS.getItem('api_keys_store').catch(() => null),
    AS.getItem('api_keys_enabled_v1').catch(() => null),
  ]);
  const parsed = saved ? JSON.parse(saved) as Record<string, string> : {};
  const enabled = enabledRaw ? JSON.parse(enabledRaw) as Record<string, boolean> : {};
  const allActiveKeys: string[] = [];
  for (let i = 1; i <= 13; i++) {
    const k = parsed[`gemini_${i}`];
    if (k?.trim() && enabled[`gemini_${i}`]) allActiveKeys.push(k.trim());
  }
  // Deduplicate starting from current key first
  const tryKeysOrdered = apiKey
    ? [apiKey, ...allActiveKeys.filter(k => k !== apiKey)]
    : allActiveKeys;

  let lastError: Error | null = null;

  // Try each client key in order
  for (const key of tryKeysOrdered.length > 0 ? tryKeysOrdered : [undefined as any]) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${REPLIT_API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: trimmed, systemPrompt, ...(key ? { apiKey: key } : {}) }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (res.status === 429 && tryKeysOrdered.length > 1) {
        // Quota exceeded — try next client key
        lastError = new Error('quota');
        continue;
      }
      if (!res.ok) {
        const err = await res.json() as any;
        throw new Error(err?.error || `HTTP ${res.status}`);
      }
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error);
      return data.content || 'பதில் இல்லை';
    } catch (e: any) {
      clearTimeout(timer);
      if (e?.message === 'quota' || e?.name === 'AbortError') { lastError = e; continue; }
      throw e;
    }
  }

  // All client keys exhausted — let server try with its own keys (no clientApiKey)
  if (lastError?.message === 'quota' && tryKeysOrdered.length > 0) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const res = await fetch(`${REPLIT_API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: trimmed, systemPrompt }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) { const err = await res.json() as any; throw new Error(err?.error || `HTTP ${res.status}`); }
      const data = await res.json() as any;
      if (data.error) throw new Error(data.error);
      return data.content || 'பதில் இல்லை';
    } catch (e: any) {
      clearTimeout(timer);
      throw e;
    }
  }

  throw lastError || new Error('பதில் வரல. மீண்டும் try பண்ணுங்க.');
}

export async function generateImage(params: {
  imgFace?: string;
  imgBody?: string;
  imgAttire?: string;
  imagePrompt?: string;
  personaName?: string;
  mode?: 'single' | 'together';
}): Promise<{ b64_json: string; mimeType: string }> {
  // Use our own API server → fal.ai Flux Schnell (~$0.003/image, ~10s)
  const startRes = await fetch('/api/generate-image/start', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imgFace: params.imgFace,
      imgBody: params.imgBody,
      imgAttire: params.imgAttire,
      imagePrompt: params.imagePrompt,
      personaName: params.personaName,
    }),
  });
  if (!startRes.ok) throw new Error(`Start failed: ${startRes.status}`);
  const { jobId } = await startRes.json() as { jobId: string };
  if (!jobId) throw new Error('No job ID received');

  // Poll every 3s, up to 3 min
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 3000));
    try {
      const pollRes = await fetch(`/api/generate-image/status/${jobId}`);
      if (!pollRes.ok) continue;
      const data = await pollRes.json() as any;
      if (data.status === 'done' && data.result) return data.result;
      if (data.status === 'error') throw new Error(data.error || 'Image generation failed');
    } catch (e: any) {
      if (e.message && !e.message.includes('fetch')) throw e;
    }
  }
  throw new Error('⏱ Timeout — மீண்டும் try பண்ணுங்க.');
}

// Direct client → Cloudinary upload (unsigned preset, no server hop)
const CLOUDINARY_CLOUD = 'dazmrxsyc';
const CLOUDINARY_PRESET = 'my_girls_upload';

// URI-based upload — uses expo-file-system/legacy uploadAsync which natively
// handles file://, content://, ph:// URIs on Android/HMOS via ContentResolver.
// Falls back to RN FormData blob if legacy upload fails (covers iOS/web).
export async function uploadUriToCloudinary(
  uri: string,
  mimeType: string = 'image/jpeg',
  folder: string = 'my-girls',
): Promise<{ url: string; public_id: string; width?: number; height?: number }> {
  const isVideo = mimeType.startsWith('video');
  const endpoint = isVideo
    ? `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`
    : `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`;

  // Primary path — legacy FileSystem.uploadAsync (best for content:// on HMOS)
  try {
    const Legacy = await import('expo-file-system/legacy');
    const res = await Legacy.uploadAsync(endpoint, uri, {
      httpMethod: 'POST',
      uploadType: Legacy.FileSystemUploadType.MULTIPART,
      fieldName: 'file',
      mimeType,
      parameters: { upload_preset: CLOUDINARY_PRESET, folder },
    });
    if (res.status < 200 || res.status >= 300) {
      let msg = `Upload failed: HTTP ${res.status}`;
      try { msg = (JSON.parse(res.body) as any)?.error?.message || msg; } catch {}
      throw new Error(msg);
    }
    const data = JSON.parse(res.body) as any;
    return { url: data.secure_url, public_id: data.public_id, width: data.width, height: data.height };
  } catch (legacyErr: any) {
    // Fallback — RN FormData blob (works for file:// URIs)
    const ext = isVideo ? 'mp4' : 'jpg';
    const form = new FormData();
    form.append('file', { uri, type: mimeType, name: `upload.${ext}` } as any);
    form.append('upload_preset', CLOUDINARY_PRESET);
    form.append('folder', folder);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90000);
    try {
      const res = await fetch(endpoint, { method: 'POST', body: form, signal: controller.signal });
      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any;
        throw new Error(err?.error?.message || legacyErr?.message || `Upload failed: ${res.status}`);
      }
      const data = await res.json() as any;
      return { url: data.secure_url, public_id: data.public_id, width: data.width, height: data.height };
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function uploadToCloudinary(
  b64_json: string,
  mimeType: string = 'image/jpeg',
  folder: string = 'my-girls',
): Promise<{ url: string; public_id: string; width?: number; height?: number }> {
  const form = new FormData();
  form.append('file', `data:${mimeType};base64,${b64_json}`);
  form.append('upload_preset', CLOUDINARY_PRESET);
  form.append('folder', folder);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90000);
  try {
    const res = await fetch(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/image/upload`,
      { method: 'POST', body: form, signal: controller.signal },
    );
    if (!res.ok) {
      const err = await res.json() as any;
      throw new Error(err?.error?.message || `Upload failed: ${res.status}`);
    }
    const data = await res.json() as any;
    return { url: data.secure_url, public_id: data.public_id, width: data.width, height: data.height };
  } finally {
    clearTimeout(timer);
  }
}

export async function listCloudinaryImages(
  folder: string = 'my-girls',
): Promise<{ url: string; public_id: string }[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(
      `${REPLIT_API}/api/cloudinary/list?folder=${encodeURIComponent(folder)}`,
      { signal: controller.signal },
    );
    if (!res.ok) {
      const err = await res.json() as any;
      throw new Error(err?.error || `List failed: ${res.status}`);
    }
    const data = await res.json() as any;
    return data.images || [];
  } finally {
    clearTimeout(timer);
  }
}

export async function deleteFromCloudinary(public_id: string): Promise<void> {
  const res = await fetch(`${REPLIT_API}/api/cloudinary/delete`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_id }),
  });
  if (!res.ok) {
    const err = await res.json() as any;
    throw new Error(err?.error || 'Delete failed');
  }
}

// ── HuggingFace Inference API — Text-to-Image ─────────────────
export const HF_IMAGE_MODEL = 'Lykon/dreamshaper-xl-1-0';

export const HF_NSFW_MODELS = [
  { id: 'Lykon/dreamshaper-xl-1-0',                         label: 'DreamShaper XL',  tag: 'Realistic' },
  { id: 'SG161222/RealVisXL_V4.0',                          label: 'RealVis XL',      tag: 'Ultra Real' },
  { id: 'John6666/wai-nsfw-illustrious-sdxl-v110-sdxl',     label: 'WAI NSFW Anime',  tag: 'Anime 18+' },
  { id: 'Yntec/HyperPhotoV2',                               label: 'HyperPhoto',      tag: 'Photo' },
  { id: 'fluently/Fluently-XL-Final',                       label: 'Fluently XL',     tag: 'Quality' },
];

// Only use direct inference endpoint — NSFW models not on router whitelist
const HF_ENDPOINTS = [
  'https://api-inference.huggingface.co/models',
];

// Convert blob to base64 using FileReader (Android-safe, no arrayBuffer issues)
async function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      // result is "data:image/jpeg;base64,XXXX" — strip prefix
      const b64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(b64 || '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

export async function generateImageHuggingFace(
  prompt: string,
  hfToken: string,
  model: string = HF_IMAGE_MODEL,
): Promise<{ b64_json: string; mimeType: string }> {
  let lastError: Error = new Error('HuggingFace connection failed');

  // Try each endpoint (primary then fallback)
  for (const base of HF_ENDPOINTS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);
    try {
      const res = await fetch(`${base}/${model}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${hfToken}`,
          'Content-Type': 'application/json',
          'X-Wait-For-Model': 'true',
        },
        body: JSON.stringify({ inputs: prompt, parameters: { num_inference_steps: 20 } }),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.status === 503) {
        // Model loading — wait and retry same endpoint once
        await new Promise(r => setTimeout(r, 20000));
        const res2 = await fetch(`${base}/${model}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${hfToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ inputs: prompt }),
        });
        if (!res2.ok) {
          const e = await res2.json().catch(() => ({})) as any;
          throw new Error(e?.error || `Model unavailable (${res2.status})`);
        }
        const blob2 = await res2.blob();
        const mimeType2 = res2.headers.get('content-type') || 'image/jpeg';
        const b64_2 = await blobToBase64(blob2);
        if (!b64_2) throw new Error('Empty image response');
        return { b64_json: b64_2, mimeType: mimeType2.split(';')[0] };
      }

      if (!res.ok) {
        const contentType = res.headers.get('content-type') || '';
        if (contentType.includes('json')) {
          const e = await res.json().catch(() => ({})) as any;
          const msg = e?.error || e?.message || `HTTP ${res.status}`;
          // 401 = wrong token, 403 = gated model — no point retrying other endpoint
          if (res.status === 401) throw new Error('HuggingFace token தவறானது ❌ — Keys-ல் சரியான token போடுங்க');
          if (res.status === 403) throw new Error('இந்த model access இல்லை ❌ — HuggingFace-ல் model access request பண்ணுங்க');
          throw new Error(msg);
        }
        throw new Error(`HuggingFace error: ${res.status}`);
      }

      // Success — read as blob (Android-safe)
      const blob = await res.blob();
      const mimeType = res.headers.get('content-type') || 'image/jpeg';

      // Check if response is JSON error disguised as image
      if (mimeType.includes('json') || mimeType.includes('text')) {
        const text = await blob.text();
        let parsed: any = {};
        try { parsed = JSON.parse(text); } catch {}
        const b64 = parsed?.image || parsed?.images?.[0] || parsed?.generated_image || '';
        if (b64) return { b64_json: b64, mimeType: 'image/jpeg' };
        throw new Error(parsed?.error || 'JSON response — image இல்லை');
      }

      const b64 = await blobToBase64(blob);
      if (!b64) throw new Error('Empty image data');
      return { b64_json: b64, mimeType: mimeType.split(';')[0] };

    } catch (e: any) {
      clearTimeout(timer);
      lastError = e;
      // Don't retry auth errors
      if (e?.message?.includes('token') || e?.message?.includes('access')) throw e;
      // Try next endpoint
      continue;
    }
  }

  throw lastError;
}
