"use strict";

const toNumber = (value) => {
  const match = String(value ?? "").replace(/\s/g, "").replace(",", ".").match(/[-+]?\d*\.?\d+/);
  const number = match ? Number(match[0]) : null;
  return Number.isFinite(number) ? number : null;
};

let streamState = null;

self.onmessage = ({ data }) => {
  if (data.action === "initStream") {
    streamState = {
      action: data.streamAction,
      payload: data.payload,
      itemsProcessed: 0,
      matches: [],
      groups: new Map(),
      records: []
    };
  } 
  else if (data.action === "chunkStream") {
    if (!streamState) return;
    const items = data.items;
    streamState.itemsProcessed += items.length;

    if (streamState.action === "search") {
      const needle = String(streamState.payload.q ?? "").toLocaleLowerCase("es");
      const reference = toNumber(streamState.payload.q);
      const isGlobal = streamState.payload.prop === "*";

      for (const item of items) {
        const valStr = isGlobal ? String(item.t ?? "") : String(item.v ?? "");
        const lower = valStr.toLocaleLowerCase("es");
        const number = isGlobal ? null : toNumber(item.v);
        let ok = false;
        
        if (streamState.payload.op === "empty") ok = !item.v || item.v.trim() === "";
        else if (streamState.payload.op === "notEmpty") ok = item.v && item.v.trim() !== "";
        else if (streamState.payload.op === "equals") ok = lower === needle;
        else if (streamState.payload.op === "startsWith") ok = lower.startsWith(needle);
        else if (streamState.payload.op === "contains") ok = lower.includes(needle);
        else if (streamState.payload.op === "gt") ok = number !== null && reference !== null && number > reference;
        else if (streamState.payload.op === "lt") ok = number !== null && reference !== null && number < reference;

        if (ok) streamState.matches.push({ modelKey: item.modelKey, modelName: item.modelName, dbId: item.dbId, name: item.name });
      }
    } 
    else if (streamState.action === "segmentation") {
      for (const item of items) {
        const value = String(item.v ?? "").trim() || "Sin asignar";
        if (!streamState.groups.has(value)) streamState.groups.set(value, { elements: [], n: toNumber(value) });
        streamState.groups.get(value).elements.push({ modelKey: item.modelKey, modelName: item.modelName, dbId: item.dbId, name: item.name });
      }
    } 
    else if (streamState.action === "qualityAudit") {
      for (const item of items) {
        streamState.records.push({
          modelKey: item.modelKey, modelName: item.modelName, dbId: item.dbId, name: item.name, value: String(item.v ?? "").trim()
        });
      }
    }
  } 
  else if (data.action === "endStream") {
    if (!streamState) return;
    
    if (streamState.action === "search") {
      self.postMessage({ action: "searchDone", matches: streamState.matches });
    } 
    else if (streamState.action === "segmentation") {
      self.postMessage({ action: "segmentDone", groups: [...streamState.groups], cacheKey: streamState.payload.cacheKey, total: streamState.itemsProcessed });
    } 
    else if (streamState.action === "qualityAudit") {
      const records = streamState.records;
      const filled = records.filter(x => x.value);
      const counts = new Map();
      filled.forEach(x => counts.set(x.value, (counts.get(x.value) || 0) + 1));
      
      let rows = [];
      if (streamState.payload.rule === "empty") rows = records.filter(x => !x.value);
      else if (streamState.payload.rule === "duplicates") rows = filled.filter(x => counts.get(x.value) > 1).map(x => ({ ...x, count: counts.get(x.value) }));
      else if (streamState.payload.rule === "numeric") rows = filled.map(x => ({ ...x, number: toNumber(x.value) })).filter(x => x.number !== null).sort((a, b) => a.number - b.number);
      else rows = [...counts].map(([value, count]) => ({ value, count, isGroup: true })).sort((a, b) => b.count - a.count);
      
      const numbers = filled.map(x => toNumber(x.value)).filter(Number.isFinite);
      self.postMessage({ 
        action: "qaDone", 
        rows, 
        kpis: {
          total: records.length,
          completitud: records.length ? Math.round((filled.length / records.length) * 100) : 0,
          unicos: counts.size,
          vacios: records.length - filled.length,
          min: numbers.length ? Math.min(...numbers) : null,
          max: numbers.length ? Math.max(...numbers) : null
        }
      });
    }
    streamState = null;
  }
};