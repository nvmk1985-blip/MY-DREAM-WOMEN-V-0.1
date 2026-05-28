import { Router } from "express";
import { v2 as cloudinary } from "cloudinary";

const router = Router();

function cfg() {
  cloudinary.config({
    cloud_name: process.env["CLOUDINARY_CLOUD_NAME"],
    api_key:    process.env["CLOUDINARY_API_KEY"],
    api_secret: process.env["CLOUDINARY_API_SECRET"],
  });
  return cloudinary;
}

const PRESET_NAME = "my_girls_upload";
let presetReady = false;

async function ensurePreset() {
  if (presetReady) return;
  const cl = cfg();
  // These options make public_id = "my-girls/priya/breast/<id>"
  // so api.resources(prefix:) can find them in both Fixed & Dynamic folder modes
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

// Called on startup to ensure the preset exists
ensurePreset().catch(() => {/* silent */});

// Return the cloud config the client needs for direct upload
router.get("/cloudinary/config", async (_req, res) => {
  await ensurePreset();
  res.json({
    cloudName: process.env["CLOUDINARY_CLOUD_NAME"],
    uploadPreset: PRESET_NAME,
  });
});

// Fallback server-side upload (still kept, uses unsigned_upload)
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

    // Method 1: Dynamic Folders mode (newer Cloudinary accounts)
    try {
      const r1 = await (cl.api as any).resources_by_asset_folder(folder, {
        max_results: 50,
        resource_type: "image",
      });
      if (r1?.resources?.length) resources = r1.resources;
    } catch {}

    // Method 2: Traditional prefix mode (older accounts)
    if (resources.length === 0) {
      try {
        const r2 = await cl.api.resources({
          type: "upload",
          resource_type: "image",
          prefix: folder + "/",
          max_results: 50,
        });
        if (r2?.resources?.length) resources = r2.resources;
      } catch {}
    }

    // Method 3: asset_folder query param
    if (resources.length === 0) {
      try {
        const r3 = await cl.api.resources({
          asset_folder: folder,
          max_results: 50,
          resource_type: "image",
        } as any);
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

// Debug: list ALL images in my-girls root to find actual paths
router.get("/cloudinary/debug-all", async (req, res) => {
  try {
    const cl = cfg();
    // List all in my-girls recursively
    const result = await cl.api.resources({
      type: "upload",
      resource_type: "image",
      prefix: "my-girls/",
      max_results: 50,
    });
    res.json({
      total: result.resources?.length,
      paths: result.resources?.map((r: any) => ({
        public_id: r.public_id,
        folder: r.folder,
        url: r.secure_url?.slice(0, 100),
      })),
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
      const r1 = await (cl.api as any).resources_by_asset_folder(folder, {
        max_results: 100, resource_type: "video",
      });
      if (r1?.resources?.length) resources = r1.resources;
    } catch {}

    if (resources.length === 0) {
      try {
        const r2 = await cl.api.resources({
          type: "upload", resource_type: "video",
          prefix: folder + "/", max_results: 100,
        });
        if (r2?.resources?.length) resources = r2.resources;
      } catch {}
    }

    if (resources.length === 0) {
      try {
        const r3 = await (cl.api as any).resources({
          asset_folder: folder, max_results: 100, resource_type: "video",
        });
        if (r3?.resources?.length) resources = r3.resources;
      } catch {}
    }

    const videos = resources.map((r: any) => ({
      url: r.secure_url || r.url,
      public_id: r.public_id,
      format: r.format || "mp4",
      duration: r.duration,
    }));

    res.json({ videos });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || "Video list failed" });
  }
});

export default router;
