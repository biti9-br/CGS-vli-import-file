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
const TEMPLATE_CONFIG_FILE = path.join(__dirname, "template", "template.json");
const TEMPLATE_XLSX_FILE = path.join(__dirname, "template", "Template Padrão.xlsx");

// ---- Retry helper ----
// Wraps fetch with exponential backoff retry (2s, 4s) for transient network errors.
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
  throw new Error('Todas as tentativas de fetch falharam');
}

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
    // Cap job-level logs at 500 entries to prevent huge JSON files for large imports
    if (job!.logs.length > 500) {
      job!.logs = job!.logs.slice(-500);
    }
    job!.updatedAt = new Date().toISOString();
    await saveJob(job!);
    // writeLog is now async-buffered; does NOT block the event loop
    writeLog({ type, message: `[${jobId}] ${message}`, details });
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

      // 1. POST /files (with retry)
      const createPayload: any = { 
        reference: row.reference,
        close: job.config.closeExisting ? 1 : 0
      };
      if (row.location) createPayload.location_id = row.location;

      await addLog('info', `[${i+1}/${job.total}] Chamada API: POST /files`, createPayload);

      let createResponse: Response;
      try {
        createResponse = await fetchWithRetry(`https://api.cargosnap.com/api/v2/files?token=${job.config.apiToken}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify(createPayload)
        });
      } catch (fetchErr: any) {
        await addLog('error', `[${i+1}/${job.total}] Erro de rede ao criar arquivo (pulando registro): ${fetchErr.message}`);
        job.progress = i + 1;
        await saveJob(job);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue; // Skip this record, do not abort the job
      }

      if (!createResponse.ok) {
        const errorData = await createResponse.json().catch(() => ({}));
        await addLog('error', `[${i+1}/${job.total}] Falha ao criar arquivo (pulando registro): ${createResponse.status}`, errorData);
        job.progress = i + 1;
        await saveJob(job);
        await new Promise(resolve => setTimeout(resolve, 500));
        continue; // Skip this record, do not abort the job
      }
      
      const createData = await createResponse.json().catch(() => ({}));
      await addLog('success', `[${i+1}/${job.total}] Sucesso: POST /files`, createData);

      // 2. POST /fields (with retry)
      const fieldsPayload = Object.keys(row)
        .filter(k => k !== 'reference' && k !== 'location')
        .filter(k => {
          const val = row[k];
          return val !== null && val !== undefined && String(val).trim() !== "";
        })
        .map(k => ({ id: k, value: row[k] }));

      if (fieldsPayload.length > 0) {
        await addLog('info', `[${i+1}/${job.total}] Chamada API: POST /fields/${row.reference}`, fieldsPayload);

        let fieldsResponse: Response;
        try {
          fieldsResponse = await fetchWithRetry(`https://api.cargosnap.com/api/v2/fields/${encodeURIComponent(row.reference)}?token=${job.config.apiToken}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify(fieldsPayload)
          });
        } catch (fetchErr: any) {
          await addLog('error', `[${i+1}/${job.total}] Erro de rede ao atualizar campos (pulando): ${fetchErr.message}`);
          job.progress = i + 1;
          await saveJob(job);
          await new Promise(resolve => setTimeout(resolve, 500));
          continue;
        }

        if (!fieldsResponse.ok) {
          const errorData = await fieldsResponse.json().catch(() => ({}));
          await addLog('error', `[${i+1}/${job.total}] Falha ao atualizar campos (pulando registro): ${fieldsResponse.status}`, errorData);
        } else {
          const fieldsData = await fieldsResponse.json().catch(() => ({}));
          await addLog('success', `[${i+1}/${job.total}] Sucesso: POST /fields/${row.reference}`, fieldsData);
        }
      }

      job.progress = i + 1;
      await saveJob(job);
      
      // Delay de 500ms para respeitar o limite de requisições da API
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

// ---- Async buffered global log writer ----
// Accumulates log entries in memory and flushes to disk every 5 seconds.
// This avoids synchronous 7MB file reads/writes on every loop iteration.
const _logBuffer: any[] = [];
let _logFlushScheduled = false;

async function flushGlobalLogs() {
  _logFlushScheduled = false;
  if (_logBuffer.length === 0) return;
  const toFlush = _logBuffer.splice(0, _logBuffer.length);
  try {
    let existing: any[] = [];
    if (fsSync.existsSync(LOGS_FILE)) {
      try {
        existing = JSON.parse(await fs.readFile(LOGS_FILE, 'utf-8'));
      } catch {
        existing = [];
      }
    }
    const merged = [...toFlush, ...existing].slice(0, 10000);
    await fs.writeFile(LOGS_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to flush global logs', error);
  }
}

async function writeLog(log: any) {
  _logBuffer.unshift({ ...log, timestamp: new Date().toISOString() });
  if (!_logFlushScheduled) {
    _logFlushScheduled = true;
    setTimeout(flushGlobalLogs, 5000);
  }
}

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
          config.templateFileBase64 = `data:application/vnd.openxmlformats-officedocument.spreadsheetml.sheet;base64,${xlsxBuffer.toString('base64')}`;
        } catch (e) {
          // ignore if xlsx not found
        }
        return config;
      } catch (e) {
        return null;
      }
    }
    throw error;
  }
}

async function writeConfig(config: any) {
  // Save to main config file
  await fs.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), "utf-8");
  
  // Also update the template directory to make it the new default
  try {
    const templateDir = path.join(__dirname, "template");
    await fs.mkdir(templateDir, { recursive: true });
    
    // Create a copy of config without the base64 file for the template config
    const { templateFileBase64, ...templateConfig } = config;
    await fs.writeFile(TEMPLATE_CONFIG_FILE, JSON.stringify(templateConfig, null, 2), "utf-8");
    
    // If there's a template file, save it as the new default XLSX
    if (templateFileBase64) {
      const base64Data = templateFileBase64.split(';base64,').pop();
      if (base64Data) {
        await fs.writeFile(TEMPLATE_XLSX_FILE, Buffer.from(base64Data, 'base64'));
      }
    }
  } catch (error) {
    console.error('Failed to update template directory', error);
    // We don't throw here to avoid failing the main config save
  }
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

// ---- Recover stale jobs after container restart ----
// If the server restarts while a job was running, reset it to 'paused' so the user can resume.
async function recoverStaleJobs() {
  try {
    await ensureJobsDir();
    const files = await fs.readdir(JOBS_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const data = await fs.readFile(path.join(JOBS_DIR, file), 'utf-8');
        const job = JSON.parse(data) as ImportJob;
        if (job.status === 'running') {
          job.status = 'paused';
          job.logs.push({ type: 'info', message: 'Job recuperado após reinício do servidor. Retome manualmente.', time: new Date().toLocaleTimeString() });
          job.updatedAt = new Date().toISOString();
          await saveJob(job);
          console.log(`[Recovery] Job ${job.id} estava em 'running', revertido para 'paused'.`);
        }
      } catch (e) {
        console.error(`[Recovery] Falha ao processar job file: ${file}`, e);
      }
    }
  } catch (e) {
    console.error('[Recovery] Falha ao recuperar jobs:', e);
  }
}

async function startServer() {
  const app = express();
  const PORT = Number(process.env.PORT) || 3000;

  app.use(express.json({ limit: '50mb' }));
  app.use(express.urlencoded({ limit: '50mb', extended: true }));

  // Recover any jobs that were left in 'running' state from a previous server session
  await recoverStaleJobs();

  // Ensure template directory is updated with current config on startup
  try {
    const configExists = fsSync.existsSync(CONFIG_FILE);
    if (configExists) {
      const currentConfig = await readConfig();
      if (currentConfig) {
        // Sync current config to template directory to ensure it persists as the new default
        await writeConfig(currentConfig);
        writeLog({ type: 'info', message: 'Configuração atual persistida como novo padrão default no diretório de template.' });
      }
    } else {
      writeLog({ type: 'info', message: 'Iniciando com configurações padrão do diretório de template.' });
    }
  } catch (e) {
    console.error('Failed to initialize template from current config', e);
  }

  // Dynamic Environment Variables Injection
  app.get("/env-config.js", (req, res) => {
    const env = {
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
      MY_APP_URL: process.env.MY_APP_URL || "",
    };
    res.type("application/javascript");
    res.send(`window.ENV = ${JSON.stringify(env)};`);
  });

  // API Routes
  app.get("/api/config", async (req, res) => {
    try {
      const config = await readConfig();
      res.json(config);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.get("/api/template/download", async (req, res) => {
    try {
      // Check if the template file exists
      try {
        await fs.access(TEMPLATE_XLSX_FILE);
        res.download(TEMPLATE_XLSX_FILE, "Template_Padrao.xlsx");
      } catch (e) {
        res.status(404).json({ error: "Template file not found" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/config", async (req, res) => {
    try {
      const { referenceColumn, locationId, locationColumn, columnMapping, rawHeaders, fileName, sampleData, templateFileBase64 } = req.body;
      
      const config = {
        referenceColumn,
        locationId,
        locationColumn,
        columnMapping,
        rawHeaders,
        fileName,
        sampleData,
        templateFileBase64,
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

  app.delete("/api/logs", async (req, res) => {
    try {
      await fs.writeFile(LOGS_FILE, JSON.stringify([], null, 2), 'utf-8');
      await writeLog({ type: 'info', message: 'Histórico de logs limpo pelo administrador.' });
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

  app.delete("/api/jobs/:id", async (req, res) => {
    try {
      const id = req.params.id;
      const jobPath = path.join(JOBS_DIR, `${id}.json`);
      if (activeJobs.has(id)) {
        return res.status(400).json({ error: 'Cannot delete a running job' });
      }
      await fs.unlink(jobPath);
      await writeLog({ type: 'info', message: `Importação excluída pelo usuário: Job ${id}` });
      res.json({ success: true });
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

  app.listen(PORT, "0.0.0.0", async () => {
    console.log(`Server running on http://localhost:${PORT}`);
    await writeLog({ type: 'info', message: 'Servidor iniciado e pronto para operações.' });
  });
}

startServer();
