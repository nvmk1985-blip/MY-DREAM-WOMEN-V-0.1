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

export async function sendMessage(
  messages: { role: string; content: string }[],
  _provider: string = 'gemini',
  systemPrompt?: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  // Keep only last 10 messages to reduce token count and speed up response
  const trimmed = messages.slice(-10);

  // Read Gemini API key saved by user — only use it if the user enabled the toggle
  let apiKey: string | undefined;
  try {
    const AS = (await import('@react-native-async-storage/async-storage')).default;
    const [saved, enabledRaw] = await Promise.all([
      AS.getItem('api_keys_store'),
      AS.getItem('api_keys_enabled_v1'),
    ]);
    const enabled = enabledRaw ? (JSON.parse(enabledRaw) as Record<string, boolean>) : {};
    if (saved && enabled['gemini']) {
      const parsed = JSON.parse(saved) as Record<string, string>;
      apiKey = parsed['gemini'] || undefined;
    }
  } catch { /* ignore — server env key will be used */ }

  try {
    // Use Replit API server (Gemini, always-on, no cold start)
    const res = await fetch(`${REPLIT_API}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: trimmed, systemPrompt, ...(apiKey ? { apiKey } : {}) }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.json() as any;
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    const data = await res.json() as any;
    if (data.error) throw new Error(data.error);
    return data.content || 'பதில் இல்லை';
  } finally {
    clearTimeout(timer);
  }
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
