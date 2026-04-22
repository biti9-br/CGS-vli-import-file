import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, "config.json");
const TEMPLATE_CONFIG_FILE = path.join(__dirname, "template", "template.json");
const TEMPLATE_XLSX_FILE = path.join(__dirname, "template", "Template Padrão.xlsx");

// ---- Firebase Admin ----
// On Cloud Run, credentials are handled automatically by ADC (Application Default Credentials).
// Locally, set GOOGLE_APPLICATION_CREDENTIALS to your service account key path.
if (!getApps().length) {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || "cgs-ai" });
}
const db = getFirestore();

// Firestore collections
const jobsCol = db.collection("jobs");
const payloadsCol = db.collection("payloads");
const logsCol = db.collection("logs");

// ---- Retry helper ----
async function fetchWithRetry(url: string, options: RequestInit, retries = 3): Promise<Response> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetch(url, options);
    } catch (err: any) {
      if (attempt === retries) throw err;
      const delay = attempt * 2000;
      console.warn(`[fetchWithRetry] Tentativa ${attempt}/${retries} falhou. Aguardando ${delay}ms...`, err?.message);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error("Todas as tentativas de fetch falharam");
}

// ---- In-memory tracking ----
// Tokens are never persisted to Firestore — kept only in memory for the active session.
const activeJobs = new Set<string>();
const stopSignals = new Set<string>();
const jobTokens = new Map<string, string>(); // jobId → apiToken

// ---- Log helper ----
async function writeLog(type: string, message: string, jobId?: string, details?: any) {
  console.log(`[${type.toUpperCase()}]${jobId ? ` [${jobId}]` : ""} ${message}`);
  try {
    const entry: Record<string, any> = {
      type,
      message,
      timestamp: FieldValue.serverTimestamp(),
    };
    if (jobId) entry.jobId = jobId;
    if (details) entry.details = (typeof details === "string" ? details : JSON.stringify(details)).slice(0, 5000);
    await logsCol.add(entry);
  } catch (e) {
    console.error("Failed to write log to Firestore:", e);
  }
}

// ---- Helper: convert Firestore Timestamp to ISO string ----
function tsToIso(val: any): string | null {
  if (!val) return null;
  if (val instanceof Timestamp) return val.toDate().toISOString();
  return String(val);
}

// ---- Job processor ----
async function processJob(jobId: string) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  stopSignals.delete(jobId);

  const jobRef = jobsCol.doc(jobId);

  // Try memory first, then fall back to Firestore (survives container restarts)
  let apiToken = jobTokens.get(jobId);
  if (!apiToken) {
    try {
      const snap = await jobRef.get();
      apiToken = snap.data()?.apiToken;
    } catch {}
  }

  if (!apiToken) {
    console.error(`[processJob] Token não encontrado para job ${jobId}. Pausando.`);
    await jobRef.update({ status: "paused", updatedAt: FieldValue.serverTimestamp() });
    activeJobs.delete(jobId);
    return;
  }

  try {
    const jobSnap = await jobRef.get();
    if (!jobSnap.exists) { activeJobs.delete(jobId); return; }

    const { closeExisting } = jobSnap.data()!;

    await jobRef.update({ status: "running", updatedAt: FieldValue.serverTimestamp() });
    await writeLog("info", "Processamento iniciado.", jobId);

    // Fetch pending payloads for this job
    // NOTE: No .orderBy() here — composite indexes not yet deployed.
    // We sort in memory to avoid "requires an index" Firestore errors.
    let pendingSnap;
    try {
      pendingSnap = await payloadsCol
        .where("jobId", "==", jobId)
        .where("status", "==", "pending")
        .get();
    } catch (queryErr: any) {
      console.error(`[processJob] Falha ao buscar payloads: ${queryErr.message}`);
      await jobRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() });
      await writeLog("error", `Falha ao buscar payloads: ${queryErr.message}`, jobId);
      return;
    }

    if (pendingSnap.empty) {
      await jobRef.update({ status: "completed", updatedAt: FieldValue.serverTimestamp() });
      await writeLog("success", "Nenhum payload pendente. Job concluído.", jobId);
      return;
    }

    // sort by rowIndex in memory
    const pendingDocs = pendingSnap.docs.slice().sort((a, b) => (a.data().rowIndex ?? 0) - (b.data().rowIndex ?? 0));

    let processed = 0;
    const total = pendingDocs.length;

    for (const doc of pendingDocs) {
      // Check for stop signal
      if (stopSignals.has(jobId)) {
        await jobRef.update({ status: "paused", updatedAt: FieldValue.serverTimestamp() });
        await writeLog("info", `Pausado após ${processed}/${total} registros.`, jobId);
        return;
      }

      const payload = doc.data();
      const label = `[${payload.rowIndex + 1}] ${payload.reference}`;
      let rowOk = false;

      // Step 1: POST /files
      try {
        const body: Record<string, any> = {
          reference: payload.reference,
          close: closeExisting ? 1 : 0,
        };
        if (payload.locationId) body.location_id = payload.locationId;

        const res = await fetchWithRetry(
          `https://api.cargosnap.com/api/v2/files?token=${apiToken}`,
          { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body) }
        );

        if (res.ok) {
          rowOk = true;
        } else {
          const errData = await res.json().catch(() => ({}));
          await doc.ref.update({ status: "error", errorMessage: `POST /files ${res.status}`, sentAt: FieldValue.serverTimestamp() });
          await writeLog("error", `${label} Falha POST /files: ${res.status}`, jobId, errData);
        }
      } catch (e: any) {
        await doc.ref.update({ status: "error", errorMessage: e.message, sentAt: FieldValue.serverTimestamp() });
        await writeLog("error", `${label} Erro de rede: ${e.message}`, jobId);
      }

      // Step 2: POST /fields (only if /files succeeded and fields exist)
      if (rowOk && payload.fields && Object.keys(payload.fields).length > 0) {
        const fieldsBody = Object.entries(payload.fields).map(([id, value]) => ({ id, value }));
        try {
          const res = await fetchWithRetry(
            `https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(payload.reference)}?token=${apiToken}`,
            { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(fieldsBody) }
          );

          if (res.ok) {
            await doc.ref.update({ status: "sent", errorMessage: null, sentAt: FieldValue.serverTimestamp() });
          } else {
            const errData = await res.json().catch(() => ({}));
            await doc.ref.update({ status: "error", errorMessage: `POST /fields ${res.status}`, sentAt: FieldValue.serverTimestamp() });
            await writeLog("error", `${label} Falha POST /fields: ${res.status}`, jobId, errData);
          }
        } catch (e: any) {
          await doc.ref.update({ status: "error", errorMessage: e.message, sentAt: FieldValue.serverTimestamp() });
          await writeLog("error", `${label} Erro de rede /fields: ${e.message}`, jobId);
        }
      } else if (rowOk) {
        // No fields configured, mark as sent
        await doc.ref.update({ status: "sent", errorMessage: null, sentAt: FieldValue.serverTimestamp() });
      }

      processed++;
      await jobRef.update({ progress: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() });

      // Log progress every 100 records
      if (processed % 100 === 0) {
        await writeLog("info", `${processed}/${total} registros processados.`, jobId);
      }

      // Rate limiting: 500ms between API calls
      await new Promise(r => setTimeout(r, 500));
    }

    // Verify all done
    const remaining = await payloadsCol
      .where("jobId", "==", jobId)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (remaining.empty) {
      await jobRef.update({ status: "completed", updatedAt: FieldValue.serverTimestamp() });
      await writeLog("success", `Importação concluída! ${processed} registros enviados.`, jobId);
    }
  } catch (error: any) {
    try { await jobRef.update({ status: "failed", updatedAt: FieldValue.serverTimestamp() }); } catch {}
    await writeLog("error", `Erro interno: ${error.message}`, jobId, error.stack);
  } finally {
    activeJobs.delete(jobId);
    stopSignals.delete(jobId);
    jobTokens.delete(jobId);
  }
}

// ---- Startup: recover jobs stuck in 'running' after container restart ----
async function recoverStaleJobs() {
  try {
    const snap = await jobsCol.where("status", "==", "running").get();
    for (const doc of snap.docs) {
      await doc.ref.update({ status: "paused", updatedAt: FieldValue.serverTimestamp() });
      console.log(`[Recovery] Job ${doc.id} revertido para paused.`);
    }
  } catch (e) {
    console.error("[Recovery] Falha:", e);
  }
}

// ---- Config helpers (file-based — settings not migrated yet) ----
async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      try {
        const templateData = await fs.readFile(TEMPLATE_CONFIG_FILE, "utf-8");
        const config = JSON.parse(templateData);
        try {
          const xlsxBuffer = await fs.readFile(TEMPLATE_XLSX_FILE);
          config.templateFileBase64 = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsxBuffer.toString("base64")}`;
        } catch {}
        return config;
      } catch {
        return null;
      }
    }
    throw error;
  }
}

async function writeConfig(config: any) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  try {
    const templateDir = path.join(__dirname, "template");
    await fs.mkdir(templateDir, { recursive: true });
    const { templateFileBase64, ...templateConfig } = config;
    await fs.writeFile(TEMPLATE_CONFIG_FILE, JSON.stringify(templateConfig, null, 2), "utf-8");
    if (templateFileBase64) {
      const base64Data = templateFileBase64.split(";base64,").pop();
      if (base64Data) await fs.writeFile(TEMPLATE_XLSX_FILE, Buffer.from(base64Data, "base64"));
    }
  } catch (e) {
    console.error("Failed to update template directory:", e);
  }
}

async function deleteConfig() {
  try {
    await fs.unlink(CONFIG_FILE);
  } catch (error: any) {
    if (error.code !== "ENOENT") throw error;
  }
}

// ---- Batch delete helper ----
async function batchDelete(query: FirebaseFirestore.Query) {
  let snap = await query.limit(500).get();
  while (!snap.empty) {
    const batch = db.batch();
    snap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
    snap = await query.limit(500).get();
  }
}

// ---- Server ----
async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));

  await recoverStaleJobs();

  // Sync config to template on startup
  try {
    if (fsSync.existsSync(CONFIG_FILE)) {
      const cfg = await readConfig();
      if (cfg) await writeConfig(cfg);
    }
  } catch (e) {
    console.error("Failed to sync config on startup:", e);
  }

  // ---- Dynamic env injection (for frontend) ----
  app.get("/env-config.js", (req, res) => {
    const env = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      MY_APP_URL: process.env.MY_APP_URL || "",
      FIREBASE_API_KEY: process.env.FIREBASE_API_KEY || "",
      FIREBASE_AUTH_DOMAIN: process.env.FIREBASE_AUTH_DOMAIN || "",
      FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || "",
      FIREBASE_STORAGE_BUCKET: process.env.FIREBASE_STORAGE_BUCKET || "",
      FIREBASE_MESSAGING_SENDER_ID: process.env.FIREBASE_MESSAGING_SENDER_ID || "",
      FIREBASE_APP_ID: process.env.FIREBASE_APP_ID || "",
    };
    res.type("application/javascript");
    res.send(`window.ENV = ${JSON.stringify(env)};`);
  });

  // ---- Config API ----
  app.get("/api/config", async (req, res) => {
    try {
      res.json(await readConfig());
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const { referenceColumn, locationId, locationColumn, columnMapping, rawHeaders, fileName, sampleData, templateFileBase64 } = req.body;
      const config = { referenceColumn, locationId, locationColumn, columnMapping, rawHeaders, fileName, sampleData, templateFileBase64, updatedAt: new Date().toISOString() };
      await writeConfig(config);
      await writeLog("info", `Configuração atualizada (reference: ${referenceColumn}).`);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/config", async (req, res) => {
    try {
      await deleteConfig();
      await writeLog("info", "Configuração removida pelo administrador.");
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/template/download", async (req, res) => {
    try {
      await fs.access(TEMPLATE_XLSX_FILE);
      res.download(TEMPLATE_XLSX_FILE, "Template_Padrao.xlsx");
    } catch {
      res.status(404).json({ error: "Template file not found" });
    }
  });

  // ---- Logs API (Firestore) ----
  app.get("/api/logs", async (req, res) => {
    try {
      const snap = await logsCol.orderBy("timestamp", "desc").limit(1000).get();
      const logs = snap.docs.map(d => ({
        id: d.id,
        ...d.data(),
        timestamp: tsToIso(d.data().timestamp),
      }));
      res.json(logs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/logs", async (req, res) => {
    try {
      await writeLog(req.body.type || "info", req.body.message || "", req.body.jobId, req.body.details);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.delete("/api/logs", async (req, res) => {
    try {
      await batchDelete(logsCol as any);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Jobs API (Firestore) ----

  // Create job + payloads
  app.post("/api/jobs", async (req, res) => {
    try {
      const { data, config } = req.body as { data: any[]; config: { apiToken: string; closeExisting: boolean } };
      if (!data?.length) return res.status(400).json({ error: "data array is required" });

      const id = crypto.randomUUID();
      const jobRef = jobsCol.doc(id);

      // Create job document — apiToken persisted to survive container restarts
      // It is never returned in GET responses (stripped server-side)
      await jobRef.set({
        status: "pending",
        progress: 0,
        total: data.length,
        closeExisting: config.closeExisting ?? false,
        apiToken: config.apiToken,
        fileName: "",
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });

      // Also keep in memory for fast access in the current session
      jobTokens.set(id, config.apiToken);

      // Create payload documents in batches of 500
      const BATCH_SIZE = 500;
      for (let i = 0; i < data.length; i += BATCH_SIZE) {
        const batch = db.batch();
        data.slice(i, i + BATCH_SIZE).forEach((row: any, idx: number) => {
          const { reference, location, ...fields } = row;
          // Filter out empty fields
          const cleanFields: Record<string, string> = {};
          Object.entries(fields).forEach(([k, v]) => {
            if (v !== null && v !== undefined && String(v).trim() !== "") {
              cleanFields[k] = String(v).trim();
            }
          });
          batch.set(payloadsCol.doc(), {
            jobId: id,
            rowIndex: i + idx,
            reference: String(reference || ""),
            locationId: String(location || ""),
            fields: cleanFields,
            status: "pending",
            errorMessage: null,
            sentAt: null,
            createdAt: FieldValue.serverTimestamp(),
          });
        });
        await batch.commit();
      }

      await writeLog("info", `Job ${id} criado com ${data.length} registros.`, id);
      processJob(id).catch(console.error);
      res.json({ id });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // List jobs
  app.get("/api/jobs", async (req, res) => {
    try {
      const snap = await jobsCol.orderBy("createdAt", "desc").limit(50).get();
      const jobs = snap.docs.map(d => {
        const data = d.data();
        return {
          id: d.id,
          status: data.status,
          progress: data.progress,
          total: data.total,
          closeExisting: data.closeExisting,
          fileName: data.fileName,
          createdAt: tsToIso(data.createdAt),
          updatedAt: tsToIso(data.updatedAt),
        };
      });
      res.json(jobs);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Get job details + logs
  app.get("/api/jobs/:id", async (req, res) => {
    try {
      const snap = await jobsCol.doc(req.params.id).get();
      if (!snap.exists) return res.status(404).json({ error: "Job not found" });

      const data = snap.data()!;

      // Fetch logs for this job
      // NOTE: No .orderBy() — requires composite index not yet deployed. Sorted in memory.
      let logs: any[] = [];
      let _logsError: string | undefined;
      try {
        const logsSnap = await logsCol
          .where("jobId", "==", req.params.id)
          .limit(500)
          .get();
        logs = logsSnap.docs
          .map(d => ({
            type: d.data().type,
            message: d.data().message,
            time: (d.data().timestamp instanceof Timestamp)
              ? d.data().timestamp.toDate().toLocaleTimeString("pt-BR")
              : "",
            _ts: d.data().timestamp?.toMillis?.() ?? 0,
          }))
          .sort((a, b) => b._ts - a._ts) // newest first
          .map(({ _ts, ...rest }) => rest);
      } catch (logsErr: any) {
        _logsError = logsErr.message;
        console.error(`[GET /api/jobs/:id] Falha ao buscar logs: ${logsErr.message}`);
      }

      res.json({
        id: snap.id,
        status: data.status,
        progress: data.progress,
        total: data.total,
        closeExisting: data.closeExisting,
        fileName: data.fileName,
        createdAt: tsToIso(data.createdAt),
        updatedAt: tsToIso(data.updatedAt),
        logs,
        ...(  _logsError ? { _logsError } : {}),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Stop job
  app.post("/api/jobs/:id/stop", async (req, res) => {
    try {
      const { id } = req.params;
      stopSignals.add(id);
      if (!activeJobs.has(id)) {
        await jobsCol.doc(id).update({ status: "paused", updatedAt: FieldValue.serverTimestamp() });
      }
      await writeLog("info", "Importação pausada pelo usuário.", id);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Resume job — reads persisted token from Firestore; body.apiToken overrides if needed
  app.post("/api/jobs/:id/resume", async (req, res) => {
    try {
      const { id } = req.params;
      const snap = await jobsCol.doc(id).get();
      if (!snap.exists) return res.status(404).json({ error: "Job not found" });

      const { status, apiToken: storedToken } = snap.data()!;
      if (status !== "paused" && status !== "failed") {
        return res.status(400).json({ error: `Job status is '${status}', cannot resume.` });
      }

      // Body token takes priority (allows updating), otherwise use stored token
      const apiToken = req.body.apiToken?.trim() || jobTokens.get(id) || storedToken;
      if (!apiToken) {
        return res.status(400).json({ error: "apiToken not found. Provide it in the request body." });
      }

      // Persist updated token if a new one was provided
      const updateData: Record<string, any> = { status: "pending", updatedAt: FieldValue.serverTimestamp() };
      if (req.body.apiToken?.trim()) updateData.apiToken = req.body.apiToken.trim();

      jobTokens.set(id, apiToken);
      await snap.ref.update(updateData);
      await writeLog("info", "Retomando importação...", id);
      processJob(id).catch(console.error);
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // Delete job (and its payloads + logs)
  app.delete("/api/jobs/:id", async (req, res) => {
    try {
      const { id } = req.params;
      if (activeJobs.has(id)) return res.status(400).json({ error: "Cannot delete a running job" });

      await Promise.all([
        batchDelete(payloadsCol.where("jobId", "==", id) as any),
        batchDelete(logsCol.where("jobId", "==", id) as any),
      ]);
      await jobsCol.doc(id).delete();
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- CargoSnap proxy endpoints (unchanged) ----
  app.post("/api/cargosnap/files", async (req, res) => {
    try {
      const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
      const url = token ? `https://api.cargosnap.com/api/v2/files?token=${token}` : "https://api.cargosnap.com/api/v2/files";
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(req.body) });
      res.status(response.status).json(await response.json().catch(() => ({})));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  app.post("/api/cargosnap/fields/:reference", async (req, res) => {
    try {
      const { reference } = req.params;
      const token = (req.headers.authorization || "").replace("Bearer ", "").trim();
      const url = token
        ? `https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(reference)}?token=${token}`
        : `https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(reference)}`;
      const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(req.body) });
      res.status(response.status).json(await response.json().catch(() => ({})));
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ---- Frontend serving ----
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
  }

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await writeLog("info", "Servidor iniciado e pronto para operações.");
  });
}

startServer();
