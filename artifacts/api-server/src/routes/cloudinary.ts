import { Router } from "express";
import { v2 as cloudinary } from "cloudinary";

const router = Router();

function cfg() {
  cloudinary.config({
    cloud_name: process.env["CLOUDINARY_CLOUD_NAME"],
    api_key:    process.env["API_KEY"] || process.env["CLOUDINARY_API_KEY"],
    api_secret: process.env["API_SECRET"] || process.env["CLOUDINARY_API_SECRET"],
  });
  return cloudinary;
}

const PRESET_NAME = "my_girls_upload";
let presetReady = false;

async function ensurePreset() {
  if (presetReady) return;
  const cl = cfg();
  const presetOpts = {
    unsigned: true,
    folder: "",
    use_asset_folder_as_public_id_prefix: true,
    unique_filename: true,
    overwrite: false,
  };
  try {
    await cl.api.update_upload_preset(PRESET_NAME, presetOpts);
    presetReady = true;
  } catch {
    try {
      await cl.api.create_upload_preset({ name: PRESET_NAME, ...presetOpts });
      presetReady = true;
    } catch (err: any) {
      if (err?.http_code === 409 || String(err?.message).includes("already exists")) {
        presetReady = true;
      }
    }
  }
}

ensurePreset().catch(() => {/* silent */});

router.get("/cloudinary/config", async (_req, res) => {
  await ensurePreset();
  res.json({
    cloudName: process.env["CLOUDINARY_CLOUD_NAME"],
    uploadPreset: PRESET_NAME,
  });
});

router.post("/cloudinary/upload", async (req, res) => {
  try {
    const { b64_json, mimeType = "image/jpeg", folder = "my-girls" } = req.body as {
      b64_json: string; mimeType?: string; folder?: string;
    };
    if (!b64_json) { res.status(400).json({ error: "b64_json is required" }); return; }
    await ensurePreset();
    const cl = cfg();
    const dataUri = `data:${mimeType};base64,${b64_json}`;
    const result = await cl.uploader.unsigned_upload(dataUri, PRESET_NAME, {
      folder,
      resource_type: "image",
    });
    res.json({ url: result.secure_url, public_id: result.public_id, width: result.width, height: result.height });
  } catch (err: any) {
    req.log.error({ err }, "Cloudinary upload failed");
    res.status(500).json({ error: err?.message || "Upload failed" });
  }
});

router.get("/cloudinary/list", async (req, res) => {
  try {
    const folder = (req.query["folder"] as string) || "my-girls";
    const cl = cfg();
    let resources: any[] = [];
    try {
      const r1 = await (cl.api as any).resources_by_asset_folder(folder, { max_results: 50, resource_type: "image" });
      if (r1?.resources?.length) resources = r1.resources;
    } catch {}
    if (resources.length === 0) {
      try {
        const r2 = await cl.api.resources({ type: "upload", resource_type: "image", prefix: folder + "/", max_results: 50 });
        if (r2?.resources?.length) resources = r2.resources;
      } catch {}
    }
    if (resources.length === 0) {
      try {
        const r3 = await cl.api.resources({ asset_folder: folder, max_results: 50, resource_type: "image" } as any);
        if (r3?.resources?.length) resources = r3.resources;
      } catch {}
    }
    const images = resources.map((r: any) => ({
      url: r.secure_url, public_id: r.public_id,
      width: r.width, height: r.height, created_at: r.created_at,
    }));
    res.json({ images });
  } catch (err: any) {
    req.log.error({ err }, "Cloudinary list failed");
    res.status(500).json({ error: err?.message || "List failed" });
  }
});

// Lists immediate sub-folder names inside a given Cloudinary folder
router.get("/cloudinary/subfolders", async (req, res) => {
  try {
    const folder = (req.query["folder"] as string) || "my-girls";
    const cl = cfg();
    let folderNames: string[] = [];
    // Method 1: Cloudinary sub_folders Admin API
    try {
      const r = await (cl.api as any).sub_folders(folder);
      if (r?.folders?.length) {
        folderNames = r.folders.map((f: any) => f.name ?? (f.path ?? '').split('/').pop() ?? String(f));
      }
    } catch {}
    // Method 2: Fallback — extract from resource public_ids
    if (folderNames.length === 0) {
      try {
        const depth = folder.split('/').length;
        const r = await cl.api.resources({ type: "upload", resource_type: "image", prefix: folder + "/", max_results: 500 });
        const seen = new Set<string>();
        for (const item of r.resources || []) {
          const parts = (item.public_id as string).split('/');
          if (parts.length > depth) seen.add(parts[depth]);
        }
        folderNames = [...seen];
      } catch {}
    }
    res.json({ folders: folderNames });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Subfolders failed" });
  }
});

// Shows which Cloudinary account the admin API is actually authenticated as
router.get("/cloudinary/debug-account", async (req, res) => {
  const result: Record<string,any> = {
    cloud_name: process.env["CLOUDINARY_CLOUD_NAME"] ?? null,
    api_key_set: !!(process.env["API_KEY"] || process.env["CLOUDINARY_API_KEY"]),
    api_secret_set: !!(process.env["API_SECRET"] || process.env["CLOUDINARY_API_SECRET"]),
  };
  try {
    const cl = cfg();
    const ping = await cl.api.ping();
    result["ping"] = ping;
  } catch(e: any) {
    result["ping_error"] = String(e);
  }
  try {
    const cl = cfg();
    const usage = await cl.api.usage();
    result["resources_count"] = usage?.resources;
    result["plan"] = usage?.plan;
  } catch(e: any) {
    result["usage_error"] = String(e);
  }
  res.json(result);
});

// Detailed debug: tries all 4 admin API methods and reports each result
router.get("/cloudinary/debug-detail", async (req, res) => {
  const folder = (req.query["folder"] as string) || "my-girls/test_char/test_style";
  const cl = cfg();
  const out: Record<string, any> = { folder, env: {
    cloud_name: process.env["CLOUDINARY_CLOUD_NAME"] ?? null,
    api_key_set: !!(process.env["API_KEY"] || process.env["CLOUDINARY_API_KEY"]),
    api_secret_set: !!(process.env["API_SECRET"] || process.env["CLOUDINARY_API_SECRET"]),
  }};
  // Method 1: prefix
  try { const r = await cl.api.resources({ type: "upload", resource_type: "image", prefix: folder + "/", max_results: 10 }); out["prefix"] = { count: r.resources?.length, ids: r.resources?.map((x:any)=>x.public_id) }; } catch(e:any){ out["prefix_err"] = e?.message; }
  // Method 2: resources_by_asset_folder
  try { const r = await (cl.api as any).resources_by_asset_folder(folder, { max_results: 10, resource_type: "image" }); out["by_asset_folder"] = { count: r.resources?.length, ids: r.resources?.map((x:any)=>x.public_id) }; } catch(e:any){ out["by_asset_folder_err"] = e?.message; }
  // Method 3: asset_folder param
  try { const r = await (cl.api as any).resources({ asset_folder: folder, max_results: 10, resource_type: "image" }); out["asset_folder_param"] = { count: r.resources?.length, ids: r.resources?.map((x:any)=>x.public_id) }; } catch(e:any){ out["asset_folder_param_err"] = e?.message; }
  // Method 4: root prefix (no folder filter)
  try { const r = await cl.api.resources({ type: "upload", resource_type: "image", prefix: "my-girls/", max_results: 10 }); out["root_prefix"] = { count: r.resources?.length, ids: r.resources?.map((x:any)=>x.public_id) }; } catch(e:any){ out["root_prefix_err"] = String(e); }
  // Method 5: resources_by_asset_folder("Icon") — upload preset may hardcode asset_folder=Icon
  try {
    const r = await (cl.api as any).resources_by_asset_folder("Icon", { max_results: 10, resource_type: "image" });
    out["by_asset_folder_Icon"] = { count: r.resources?.length, sample: r.resources?.slice(0,3).map((x:any)=>({id:x.public_id,af:x.asset_folder,url:x.secure_url?.slice(0,80)})) };
  } catch(e:any){ out["by_asset_folder_Icon_err"] = String(e); }
  // Method 6: list ALL resources (no filter) to see anything at all
  try {
    const r = await cl.api.resources({ type: "upload", resource_type: "image", max_results: 10 });
    out["all_resources"] = { count: r.resources?.length, sample: r.resources?.slice(0,3).map((x:any)=>({id:x.public_id,af:x.asset_folder,url:x.secure_url?.slice(0,80)})) };
  } catch(e:any){ out["all_resources_err"] = String(e); }
  res.json(out);
});

router.get("/cloudinary/debug-all", async (req, res) => {
  try {
    const cl = cfg();
    const result = await cl.api.resources({ type: "upload", resource_type: "image", prefix: "my-girls/", max_results: 50 });
    res.json({
      total: result.resources?.length,
      paths: result.resources?.map((r: any) => ({ public_id: r.public_id, folder: r.folder, url: r.secure_url?.slice(0, 100) })),
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message });
  }
});

router.delete("/cloudinary/delete", async (req, res) => {
  try {
    const { public_id } = req.body as { public_id: string };
    if (!public_id) { res.status(400).json({ error: "public_id is required" }); return; }
    await cfg().uploader.destroy(public_id);
    res.json({ success: true });
  } catch (err: any) {
    req.log.error({ err }, "Cloudinary delete failed");
    res.status(500).json({ error: err?.message || "Delete failed" });
  }
});

router.get("/cloudinary/videos", async (req, res) => {
  try {
    const folder = (req.query["folder"] as string) || "my-girls/videos";
    const cl = cfg();
    let resources: any[] = [];
    try {
      const r1 = await (cl.api as any).resources_by_asset_folder(folder, { max_results: 100, resource_type: "video" });
      if (r1?.resources?.length) resources = r1.resources;
    } catch {}
    if (resources.length === 0) {
      try {
        const r2 = await cl.api.resources({ type: "upload", resource_type: "video", prefix: folder + "/", max_results: 100 });
        if (r2?.resources?.length) resources = r2.resources;
      } catch {}
    }
    if (resources.length === 0) {
      try {
        const r3 = await (cl.api as any).resources({ asset_folder: folder, max_results: 100, resource_type: "video" });
        if (r3?.resources?.length) resources = r3.resources;
      } catch {}
    }
    if (resources.length === 0) {
      try {
        const parentParts = folder.split("/");
        const subname = parentParts.pop() || "";
        const parentFolder = parentParts.join("/") || "my-girls/videos";
        const r4 = await cl.api.resources({ type: "upload", resource_type: "video", prefix: parentFolder + "/", max_results: 300 });
        if (r4?.resources?.length) {
          resources = r4.resources.filter((r: any) => {
            const pid: string = r.public_id || "";
            const af: string = r.asset_folder || "";
            return pid.includes(subname) || af.includes(subname) || af === folder;
          });
        }
      } catch {}
    }
    const videos = resources.map((r: any) => ({
      url: r.secure_url || r.url, public_id: r.public_id, format: r.format || "mp4", duration: r.duration,
    }));
    res.json({ videos });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Video list failed" });
  }
});


// ── POST /api/cloudinary/create-folder ────────────────────────────────────
// Creates a Cloudinary folder using Admin API (requires api_key + api_secret)
// PLACEHOLDER_PNG: 1x1 transparent PNG (base64)
const PLACEHOLDER_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

router.post("/cloudinary/create-folder", async (req, res) => {
  const { folderPath } = req.body as { folderPath: string };
  if (!folderPath || folderPath.endsWith('/')) {
    return res.status(400).json({ error: "folderPath required" });
  }
  const cl = cfg();

  // Method 1: Admin API create_folder (fastest, no asset created)
  try {
    await (cl.api as any).create_folder(folderPath);
    return res.json({ ok: true, folder: folderPath, method: 'admin' });
  } catch (err: any) {
    const msg: string = err?.message || err?.error?.message || JSON.stringify(err).slice(0, 300);
    // Already exists = success
    if (msg.includes('already exists') || (err?.http_code ?? err?.error?.http_code) === 409) {
      return res.json({ ok: true, folder: folderPath, existed: true });
    }
    req.log.warn({ err: msg, folderPath }, 'Admin create_folder failed, trying upload fallback');
  }

  // Method 2: Unsigned upload fallback — upload tiny placeholder to create folder
  try {
    // Note: public_id must NOT start with '.' — Cloudinary rejects it.
    // Use '_keep' as a valid placeholder name.
    await cl.uploader.unsigned_upload(
      `data:image/png;base64,${PLACEHOLDER_B64}`,
      PRESET_NAME,
      { folder: folderPath, public_id: '_keep', resource_type: 'image' }
    );
    return res.json({ ok: true, folder: folderPath, method: 'upload' });
  } catch (err2: any) {
    const msg2: string = err2?.message || err2?.error?.message || JSON.stringify(err2).slice(0, 300);
    // Already exists = success
    if (msg2.includes('already exists') || (err2?.http_code ?? err2?.error?.http_code) === 409) {
      return res.json({ ok: true, folder: folderPath, existed: true, method: 'upload' });
    }
    req.log.error({ err: msg2, folderPath }, 'Both folder creation methods failed');
    return res.status(500).json({ error: msg2, folderPath });
  }
});

export default router;
