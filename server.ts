import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import fsSync from "fs";
import crypto from "crypto";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_FILE = path.join(__dirname, "config.json");
const LOGS_FILE = path.join(__dirname, "logs.json");
const JOBS_DIR = path.join(__dirname, "data", "jobs");

interface ImportJob {
  id: string;
  status: 'pending' | 'running' | 'paused' | 'completed' | 'failed';
  progress: number;
  total: number;
  data: any[];
  config: {
    apiToken: string;
    closeExisting: boolean;
  };
  logs: { type: string; message: string; time: string; details?: any }[];
  createdAt: string;
  updatedAt: string;
}

async function ensureJobsDir() {
  try {
    await fs.mkdir(JOBS_DIR, { recursive: true });
  } catch (e) {}
}

async function saveJob(job: ImportJob) {
  await ensureJobsDir();
  await fs.writeFile(path.join(JOBS_DIR, `${job.id}.json`), JSON.stringify(job, null, 2));
}

async function getJob(id: string): Promise<ImportJob | null> {
  try {
    const data = await fs.readFile(path.join(JOBS_DIR, `${id}.json`), 'utf-8');
    return JSON.parse(data);
  } catch (e) {
    return null;
  }
}

async function listJobs(): Promise<Partial<ImportJob>[]> {
  await ensureJobsDir();
  const files = await fs.readdir(JOBS_DIR);
  const jobs = [];
  for (const file of files) {
    if (file.endsWith('.json')) {
      try {
        const data = await fs.readFile(path.join(JOBS_DIR, file), 'utf-8');
        const job = JSON.parse(data);
        const { data: _, ...jobSummary } = job;
        jobs.push(jobSummary);
      } catch (e) {}
    }
  }
  return jobs.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

const activeJobs = new Set<string>();
const stopSignals = new Set<string>();

async function processJob(jobId: string) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);
  stopSignals.delete(jobId);

  let job = await getJob(jobId);
  if (!job) {
    activeJobs.delete(jobId);
    return;
  }

  job.status = 'running';
  job.updatedAt = new Date().toISOString();
  await saveJob(job);

  const addLog = async (type: string, message: string, details?: any) => {
    job!.logs.push({ type, message, time: new Date().toLocaleTimeString(), details });
    job!.updatedAt = new Date().toISOString();
    await saveJob(job!);
    await writeLog({ type, message: `[${jobId}] ${message}`, details });
  };

  try {
    for (let i = job.progress; i < job.data.length; i++) {
      if (stopSignals.has(jobId)) {
        job.status = 'paused';
        await addLog('info', 'Importação interrompida pelo usuário.');
        break;
      }

      const row = job.data[i];
      await addLog('info', `[${i+1}/${job.total}] Processando reference: ${row.reference}`);

      // 1. POST /files
      const createPayload: any = { 
        reference: row.reference,
        close: job.config.closeExisting ? 1 : 0
      };
      if (row.location) createPayload.location_id = row.location;

      await addLog('info', `[${i+1}/${job.total}] Chamada API: POST /files`, createPayload);

      const createResponse = await fetch(`https://api.cargosnap.com/api/v2/files?token=${job.config.apiToken}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(createPayload)
      });

      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({}));
        await addLog('error', `Falha ao criar arquivo: ${createResponse.status}`, errorData);
        job.status = 'failed';
        break;
      }
      
      const createData = await createResponse.json().catch(() => ({}));
      await addLog('success', `[${i+1}/${job.total}] Sucesso: POST /files`, createData);

      // 2. POST /fields
      const fieldsToUpdate = Object.keys(row).filter(k => k !== 'reference' && k !== 'location');
      if (fieldsToUpdate.length > 0) {
        const fieldsPayload = fieldsToUpdate.map(k => ({ id: k, value: row[k] }));
        await addLog('info', `[${i+1}/${job.total}] Chamada API: POST /fields/${row.reference}`, fieldsPayload);

        const fieldsResponse = await fetch(`https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(row.reference)}?token=${job.config.apiToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(fieldsPayload)
        });

        if (!fieldsResponse.ok) {
          const errorData = await fieldsResponse.json().catch(() => ({}));
          await addLog('error', `Falha ao atualizar campos: ${fieldsResponse.status}`, errorData);
          job.status = 'failed';
          break;
        }
        const fieldsData = await fieldsResponse.json().catch(() => ({}));
        await addLog('success', `[${i+1}/${job.total}] Sucesso: POST /fields/${row.reference}`, fieldsData);
      }

      job.progress = i + 1;
      await saveJob(job);
      
      // Delay de 500ms para respeitar o limite de requisições
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    if (job.progress === job.total && job.status !== 'failed') {
      job.status = 'completed';
      await addLog('success', 'Importação concluída com sucesso!');
    }
  } catch (error: any) {
    job.status = 'failed';
    await addLog('error', `Erro interno durante o processamento: ${error.message}`, error.stack);
  } finally {
    activeJobs.delete(jobId);
    stopSignals.delete(jobId);
    await saveJob(job!);
  }
}

async function readLogs() {
  try {
    if (!fsSync.existsSync(LOGS_FILE)) {
      return [];
    }
    const data = await fs.readFile(LOGS_FILE, "utf-8");
    try {
      return JSON.parse(data);
    } catch (e) {
      console.error('Invalid JSON in logs.json, returning empty array');
      return [];
    }
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function writeLog(log: any) {
  try {
    let logs = [];
    if (fsSync.existsSync(LOGS_FILE)) {
      const data = fsSync.readFileSync(LOGS_FILE, 'utf-8');
      try {
        logs = JSON.parse(data);
      } catch (e) {
        console.error('Invalid JSON in logs.json, starting fresh');
        logs = [];
      }
    }
    logs.unshift({ ...log, timestamp: new Date().toISOString() });
    if (logs.length > 10000) {
      logs.length = 10000;
    }
    fsSync.writeFileSync(LOGS_FILE, JSON.stringify(logs, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write log', error);
  }
}

async function readConfig() {
  try {
    const data = await fs.readFile(CONFIG_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error: any) {
    if (error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeConfig(config: any) {
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
}

async function deleteConfig() {
  try {
    await fs.unlink(CONFIG_FILE);
  } catch (error: any) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // API Routes
  app.get("/api/config", async (req, res) => {
    try {
      const config = await readConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const { referenceColumn, locationId, locationColumn, columnMapping, rawHeaders, fileName, sampleData } = req.body;
      
      const config = {
        referenceColumn,
        locationId,
        locationColumn,
        columnMapping,
        rawHeaders,
        fileName,
        sampleData,
        updatedAt: new Date().toISOString()
      };

      await writeConfig(config);
      await writeLog({ type: 'info', message: `Configuração do sistema atualizada pelo administrador (Reference: ${referenceColumn}).`, details: req.body });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.delete("/api/config", async (req, res) => {
    try {
      await deleteConfig();
      await writeLog({ type: 'info', message: 'Configuração do sistema removida pelo administrador.' });
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Logs API
  app.get("/api/logs", async (req, res) => {
    try {
      const logs = await readLogs();
      res.json(logs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/logs", async (req, res) => {
    try {
      await writeLog(req.body);
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Job Manager Endpoints
  app.post("/api/jobs", async (req, res) => {
    try {
      const { data, config } = req.body;
      const id = crypto.randomUUID();
      const job: ImportJob = {
        id,
        status: 'pending',
        progress: 0,
        total: data.length,
        data,
        config,
        logs: [{ type: 'info', message: 'Job criado na fila.', time: new Date().toLocaleTimeString() }],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      };
      await saveJob(job);
      await writeLog({ type: 'info', message: `Nova importação iniciada: Job ${id} com ${data.length} registros.` });
      
      // Start processing asynchronously
      processJob(id).catch(console.error);
      
      res.json({ id });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/jobs", async (req, res) => {
    try {
      const jobs = await listJobs();
      res.json(jobs);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/jobs/:id", async (req, res) => {
    try {
      const job = await getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      const { data, ...jobDetails } = job;
      res.json(jobDetails);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/jobs/:id/stop", async (req, res) => {
    try {
      const job = await getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      
      if (job.status === 'running' || job.status === 'pending') {
        stopSignals.add(job.id);
        if (!activeJobs.has(job.id)) {
          job.status = 'paused';
          job.logs.push({ type: 'info', message: 'Importação pausada pelo usuário.', time: new Date().toLocaleTimeString() });
          await saveJob(job);
        }
        await writeLog({ type: 'info', message: `Importação pausada pelo usuário: Job ${job.id}` });
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/jobs/:id/resume", async (req, res) => {
    try {
      const job = await getJob(req.params.id);
      if (!job) return res.status(404).json({ error: 'Job not found' });
      
      if (job.status === 'paused' || job.status === 'failed') {
        job.status = 'pending';
        job.logs.push({ type: 'info', message: 'Retomando importação...', time: new Date().toLocaleTimeString() });
        await saveJob(job);
        await writeLog({ type: 'info', message: `Importação retomada pelo usuário: Job ${job.id}` });
        processJob(job.id).catch(console.error);
      }
      res.json({ success: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // CargoSnap API Proxies
  app.post("/api/cargosnap/files", async (req, res) => {
    try {
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace("Bearer ", "").trim();
      const url = token ? `https://api.cargosnap.com/api/v2/files?token=${token}` : "https://api.cargosnap.com/api/v2/files";

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json().catch(() => ({}));
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/cargosnap/fields/:reference", async (req, res) => {
    try {
      const { reference } = req.params;
      const authHeader = req.headers.authorization || "";
      const token = authHeader.replace("Bearer ", "").trim();
      const url = token 
        ? `https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(reference)}?token=${token}` 
        : `https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(reference)}`;

      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(req.body)
      });
      const data = await response.json().catch(() => ({}));
      res.status(response.status).json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
