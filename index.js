"use strict";
require("dotenv").config();
const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const APS = "https://developer.api.autodesk.com";
const PUBLIC = path.join(__dirname, "public");
const DATA = path.join(__dirname, ".data");
const ACCOUNTS_DATA = path.join(DATA, "accounts");
const MODELS = path.resolve(__dirname, process.env.MODELS_FOLDER || "models");
const PART_SIZE = 20 * 1024 * 1024;
const WORKFLOW = "visor-bim-workflow";

let job = { id: null, state: "idle", message: "Listo", progress: 0 };
let sseClients = new Set();
let refreshRunning = false;

function normalizeBucketPart(value) {
  return String(value || "visor-bim")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96) || "visor-bim";
}

function accountFingerprint(clientId) {
  return crypto
    .createHash("sha256")
    .update(String(clientId || "missing-client-id"))
    .digest("hex")
    .slice(0, 12);
}

const config = () => {
  const clientId = process.env.APS_CLIENT_ID || "";
  const baseBucket = normalizeBucketPart(process.env.APS_BUCKET || "visor-bim");
  const fingerprint = accountFingerprint(clientId);
  
  return {
    clientId,
    clientSecret: process.env.APS_CLIENT_SECRET || "",
    bucket: `${baseBucket}-${fingerprint}`.slice(0, 128),
    baseBucket,
    fingerprint,
    stateFile: path.join(ACCOUNTS_DATA, fingerprint, "models.json"),
    refreshKey: process.env.REFRESH_KEY || "",
    includeModels: process.env.APS_INCLUDE_MODELS || "",
    excludeModels: process.env.APS_EXCLUDE_MODELS || "",
    webhookUrl: process.env.WEBHOOK_CALLBACK_URL || ""
  };
};

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "SAMEORIGIN",
    "Referrer-Policy": "same-origin",
    "Cache-Control": req.path.startsWith("/api/") ? "no-store" : "public, max-age=3600"
  });
  next();
});
app.use(express.static(PUBLIC, { index: false }));

function csvPatterns(value) {
  return String(value || "")
    .split(",")
    .map(item => item.trim().toLowerCase())
    .filter(Boolean);
}

function wildcardMatch(name, pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i").test(name);
}

function shouldPublishModel(name) {
  const c = config();
  const lower = name.toLowerCase();
  const automaticExclusions = [
    /^~\$/, /\.00\d+\.rvt$/i, /(^|[-_. ])backup([-_. ]|$)/i,
    /(^|[-_. ])respaldo([-_. ]|$)/i, /(^|[-_. ])recovery([-_. ]|$)/i,
    /(^|[-_. ])central_backup([-_. ]|$)/i, /(^|[-_. ])temp(orary)?([-_. ]|$)/i
  ];
  
  if (automaticExclusions.some(regex => regex.test(name))) return false;
  
  const includes = csvPatterns(c.includeModels);
  const excludes = csvPatterns(c.excludeModels);
  
  if (includes.length && !includes.some(pattern => wildcardMatch(lower, pattern))) return false;
  if (excludes.some(pattern => wildcardMatch(lower, pattern))) return false;
  
  return true;
}

const authHeaders = token => ({ Authorization: `Bearer ${token}` });
const toUrn = objectId => Buffer.from(objectId).toString("base64").replace(/=/g, "");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function broadcast(update) {
  job = { ...job, ...update, updatedAt: new Date().toISOString() };
  const packet = `data: ${JSON.stringify(job)}\n\n`;
  for (const client of sseClients) {
    client.write(packet);
  }
}

async function parseResponse(response) {
  const text = await response.text();
  let body;
  try { 
    body = text ? JSON.parse(text) : {}; 
  } catch { 
    body = { error: text }; 
  }
  
  if (!response.ok) {
    const message = body?.developerMessage || body?.reason || body?.error || `${response.status} ${response.statusText}`;
    throw new Error(String(message));
  }
  return body;
}

function validateConfig() {
  const c = config();
  const missing = ["clientId", "clientSecret", "bucket"].filter(key => !c[key]);
  if (missing.length) throw new Error(`Faltan variables APS: ${missing.join(", ")}`);
  return c;
}

async function getToken(scopes) {
  const c = validateConfig();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    grant_type: "client_credentials",
    scope: scopes.join(" ")
  });
  
  const response = await fetch(`${APS}/authentication/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  
  return parseResponse(response);
}

async function ensureBucketExists(token) {
  const c = validateConfig();
  const detailsUrl = `${APS}/oss/v2/buckets/${encodeURIComponent(c.bucket)}/details`;
  const checkResponse = await fetch(detailsUrl, { headers: authHeaders(token) });

  if (checkResponse.ok) return;
  
  if (checkResponse.status !== 404) {
    await parseResponse(checkResponse);
    return;
  }

  console.log(`El bucket "${c.bucket}" no existe. Creándolo...`);

  const createResponse = await fetch(`${APS}/oss/v2/buckets?region=US`, {
    method: "POST",
    headers: { ...authHeaders(token), "Content-Type": "application/json" },
    body: JSON.stringify({ bucketKey: c.bucket, policyKey: "persistent" })
  });

  await parseResponse(createResponse);
  console.log(`Bucket creado correctamente: ${c.bucket}`);
}

async function sha256(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", chunk => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

async function readState() {
  try { 
    return JSON.parse(await fsp.readFile(config().stateFile, "utf8")); 
  } catch { 
    return { models: [], updatedAt: null }; 
  }
}

async function uploadFile(filePath, objectKey, token, fileIndex, fileCount) {
  const c = config();
  const size = (await fsp.stat(filePath)).size;
  const totalParts = Math.max(1, Math.ceil(size / PART_SIZE));
  const handle = await fsp.open(filePath, "r");
  let uploadKey = "";
  
  try {
    for (let firstPart = 1; firstPart <= totalParts; firstPart += 10) {
      const numberOfParts = Math.min(10, totalParts - firstPart + 1);
      const query = new URLSearchParams({ 
        firstPart: String(firstPart), 
        parts: String(numberOfParts) 
      });
      if (uploadKey) query.set("uploadKey", uploadKey);
      
      const signedResponse = await fetch(
        `${APS}/oss/v2/buckets/${encodeURIComponent(c.bucket)}/objects/${encodeURIComponent(objectKey)}/signeds3upload?${query}`, 
        { headers: authHeaders(token) }
      );
      
      const signed = await parseResponse(signedResponse);
      uploadKey = signed.uploadKey;
      
      for (let offset = 0; offset < numberOfParts; offset++) {
        const part = firstPart + offset;
        const start = (part - 1) * PART_SIZE;
        const length = Math.min(PART_SIZE, size - start);
        const buffer = Buffer.allocUnsafe(length);
        
        await handle.read(buffer, 0, length, start);
        
        const partResponse = await fetch(signed.urls[offset], { 
          method: "PUT", 
          body: buffer 
        });
        
        if (!partResponse.ok) {
          throw new Error(`No se pudo subir la parte ${part} de ${path.basename(filePath)}`);
        }
        
        const fraction = (fileIndex + part / totalParts) / fileCount;
        broadcast({ 
          state: "uploading", 
          message: `Subiendo ${path.basename(filePath)}`, 
          progress: 5 + Math.round(fraction * 45) 
        });
      }
    }
    
    const completeResponse = await fetch(
      `${APS}/oss/v2/buckets/${encodeURIComponent(c.bucket)}/objects/${encodeURIComponent(objectKey)}/signeds3upload`, 
      {
        method: "POST",
        headers: { ...authHeaders(token), "Content-Type": "application/json" },
        body: JSON.stringify({ uploadKey })
      }
    );
    
    return parseResponse(completeResponse);
  } finally {
    await handle.close();
  }
}

async function requestTranslation(urn, token) {
  const response = await fetch(`${APS}/modelderivative/v2/designdata/job`, {
    method: "POST",
    headers: { 
      ...authHeaders(token), 
      "Content-Type": "application/json" 
    },
    body: JSON.stringify({
      input: { urn }, 
      output: { 
        formats: [{ 
          type: "svf2", 
          views: ["3d"],
          advanced: { generateMasterViews: true } // Optimización de tiempo/créditos
        }] 
      },
      misc: { workflow: WORKFLOW }
    })
  });
  await parseResponse(response);
}

async function manifestStatus(urn, token) {
  const response = await fetch(`${APS}/modelderivative/v2/designdata/${encodeURIComponent(urn)}/manifest`, { 
    headers: authHeaders(token) 
  });
  if (response.status === 404) return "pending";
  const manifest = await parseResponse(response);
  return manifest.status || "pending";
}

async function waitForTranslations(models, token, jobId) {
  const started = Date.now();
  const timeout = 45 * 60 * 1000;
  
  while (Date.now() - started < timeout) {
    if (job.id !== jobId) return;
    let complete = 0;
    
    for (const model of models) {
      if (model.status === "success") { 
        complete++; 
        continue; 
      }
      const status = await manifestStatus(model.urn, token);
      model.status = status;
      
      if (status === "success") complete++;
      if (status === "failed" || status === "timeout") {
        throw new Error(`Falló la traducción de ${model.name}`);
      }
      await sleep(150);
    }
    
    const progress = 55 + Math.round((complete / Math.max(1, models.length)) * 44);
    broadcast({ 
      state: "translating", 
      message: `Traduciendo modelos: ${complete}/${models.length}`, 
      progress 
    });
    
    if (complete === models.length) return;
    await sleep(5000);
  }
  throw new Error("La traducción excedió 45 minutos. Revise el manifiesto en APS.");
}

async function runRefresh(jobId) {
  const previousState = await readState();
  try {
    const activeConfig = config();
    broadcast({ 
      id: jobId, 
      state: "preparing", 
      message: `Cuenta APS ${activeConfig.fingerprint}: comparando archivos locales`, 
      progress: 2 
    });
    
    const entries = await fsp.readdir(MODELS, { withFileTypes: true });
    const supported = entries
      .filter(entry => entry.isFile() && /\.(rvt|ifc|nwd|dwg)$/i.test(entry.name))
      .map(entry => entry.name);
      
    const names = supported.filter(shouldPublishModel).sort((a, b) => a.localeCompare(b));
    const skipped = supported.filter(name => !shouldPublishModel(name)).sort((a, b) => a.localeCompare(b));
    
    if (!names.length) throw new Error(`No se encontraron modelos en ${MODELS}`);

    const oldByName = new Map((previousState.models || []).map(model => [model.name, model]));
    const currentNames = new Set(names);
    const deleted = (previousState.models || []).filter(model => !currentNames.has(model.name));
    
    const models = [];
    const changed = [];
    let unchangedCount = 0;

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const filePath = path.join(MODELS, name);
      const stat = await fsp.stat(filePath);
      
      broadcast({ 
        state: "preparing", 
        message: `Comparando ${name}`, 
        progress: 2 + Math.round(((i + 1) / names.length) * 18) 
      });
      
      const hash = await sha256(filePath);
      const previous = oldByName.get(name);
      
      // Bloqueo de bucles infinitos en archivos corruptos (Ahorro de créditos)
      if (previous?.sha256 === hash && previous?.urn) {
        if (["success", "failed", "timeout"].includes(previous.status)) {
          models.push({ ...previous }); 
          unchangedCount++;
        } else {
          changed.push({ name, filePath, stat, hash, previous });
        }
      } else {
        changed.push({ name, filePath, stat, hash, previous });
      }
    }

    if (!changed.length) {
      await fsp.mkdir(path.dirname(config().stateFile), { recursive: true });
      await fsp.writeFile(
        config().stateFile, 
        JSON.stringify({ models, skipped, federationMode: "shared-coordinates", updatedAt: new Date().toISOString() }, null, 2)
      );
      broadcast({
        state: "success",
        message: `Sin traducciones APS: ${unchangedCount} sin cambios, 0 actualizados, 0 nuevos, ${deleted.length} eliminados, ${skipped.length} excluidos`,
        progress: 100,
        summary: { unchanged: unchangedCount, updated: 0, added: 0, deleted: deleted.length, skipped: skipped.length, translations: 0 }
      });
      return;
    }

    const token = await getToken(["data:read", "data:write", "data:create", "bucket:read", "bucket:create"]);
    await ensureBucketExists(token.access_token);
    let updatedCount = 0;
    let addedCount = 0;

    for (let i = 0; i < changed.length; i++) {
      const item = changed[i];
      const safeName = item.name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const objectKey = `models/${item.hash.slice(0, 12)}-${safeName}`;
      
      broadcast({ 
        state: "uploading", 
        message: `Subiendo ${item.name} (${i + 1}/${changed.length})`, 
        progress: 20 + Math.round((i / changed.length) * 30) 
      });
      
      const object = await uploadFile(item.filePath, objectKey, token.access_token, i, changed.length);
      const modelUrn = toUrn(object.objectId);
      
      await requestTranslation(modelUrn, token.access_token);
      
      models.push({
        name: item.name,
        urn: modelUrn,
        sha256: item.hash,
        size: item.stat.size,
        modifiedAt: item.stat.mtime.toISOString(),
        status: "pending",
      });
      item.previous ? updatedCount++ : addedCount++;
    }

    const translatedModels = models.filter(model => model.status !== "success");
    broadcast({ 
      state: "translating", 
      message: `Verificando ${translatedModels.length} traducción(es) nueva(s)`, 
      progress: 55 
    });
    
    await waitForTranslations(translatedModels, token.access_token, jobId);

    await fsp.mkdir(path.dirname(config().stateFile), { recursive: true });
    await fsp.writeFile(
      config().stateFile, 
      JSON.stringify({ models, skipped, federationMode: "shared-coordinates", updatedAt: new Date().toISOString() }, null, 2)
    );
    
    broadcast({
      state: "success",
      message: `${unchangedCount} sin cambios, ${updatedCount} actualizados, ${addedCount} nuevos, ${deleted.length} eliminados. ${changed.length} traducción(es) APS.`,
      progress: 100,
      summary: { unchanged: unchangedCount, updated: updatedCount, added: addedCount, deleted: deleted.length, skipped: skipped.length, translations: changed.length }
    });
  } catch (error) {
    console.error(error);
    broadcast({ 
      state: "error", 
      message: `${error.message || "Error de actualización"}. Se conserva el manifiesto anterior.`, 
      progress: 0 
    });
  } finally {
    refreshRunning = false;
  }
}

app.get("/api/events", (req, res) => {
  res.set({ 
    "Content-Type": "text/event-stream", 
    "Cache-Control": "no-cache, no-transform", 
    Connection: "keep-alive" 
  });
  res.flushHeaders?.();
  sseClients.add(res);
  res.write(`data: ${JSON.stringify(job)}\n\n`);
  
  const heartbeat = setInterval(() => res.write(": keepalive\n\n"), 20000);
  req.on("close", () => { 
    clearInterval(heartbeat); 
    sseClients.delete(res); 
  });
});

app.post("/api/refresh", (req, res) => {
  const c = config();
  if (c.refreshKey && req.headers["x-refresh-key"] !== c.refreshKey) {
    return res.status(401).json({ error: "Clave incorrecta" });
  }
  if (refreshRunning) {
    return res.status(409).json({ error: "Ya existe una actualización en curso" });
  }
  
  refreshRunning = true;
  const jobId = crypto.randomUUID();
  res.status(202).json({ ok: true, jobId });
  setImmediate(() => runRefresh(jobId));
});

app.get("/api/publishing-config", (req, res) => {
  const c = config();
  res.json({
    mode: "isolated-models-shared-coordinates",
    includeModels: csvPatterns(c.includeModels),
    excludeModels: csvPatterns(c.excludeModels),
    linkedModelsBundled: false,
    derivativeViews: ["3d"]
  });
});

app.get("/api/aps-profile", (req, res) => {
  const c = config();
  res.json({ 
    profile: c.fingerprint, 
    bucket: c.bucket, 
    stateFile: path.relative(__dirname, c.stateFile) 
  });
});

app.get("/api/models", async (req, res) => {
  const c = config();
  try {
    const state = JSON.parse(await fsp.readFile(c.stateFile, "utf8"));
    res.json({ ...state, apsProfile: c.fingerprint, bucket: c.bucket });
  } catch {
    res.status(404).json({
      error: "Esta cuenta APS todavía no tiene modelos traducidos. Pulse Actualizar modelo una vez.",
      apsProfile: c.fingerprint,
      bucket: c.bucket
    });
  }
});

app.get("/api/token", async (req, res) => {
  try { 
    res.json(await getToken(["viewables:read"])); 
  } catch (error) { 
    res.status(500).json({ error: error.message }); 
  }
});

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC, "viewer.html")));

app.listen(PORT, () => { 
  const c = config(); 
  console.log(`\nVisor BIM Analítico V5: http://localhost:${PORT}\nPerfil APS: ${c.fingerprint}\nBucket activo: ${c.bucket}\n`); 
});