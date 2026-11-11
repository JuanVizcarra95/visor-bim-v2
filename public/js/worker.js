"use strict";

const toNumber = (value) => {
  const match = String(value ?? "")
    .replace(/\s/g, "")
    .replace(",", ".")
    .match(/[-+]?\d*\.?\d+/);
  const number = match ? Number(match[0]) : null;
  return Number.isFinite(number) ? number : null;
};

self.onmessage = ({ data: { action, payload } }) => {
  const items = payload.items || [];
  
  if (action === "search") {
    const needle = String(payload.q ?? "").toLocaleLowerCase("es");
    const reference = toNumber(payload.q);
    const matches = [];
    
    for (const item of items) {
      const values = payload.prop === "*" 
        ? [item.name, ...item.properties.map(p => p.displayValue)] 
        : item.properties.filter(p => p.displayName === payload.prop).map(p => p.displayValue);
        
      const ok = values.some(value => {
        const text = String(value ?? "");
        const lower = text.toLocaleLowerCase("es");
        const number = toNumber(text);
        
        if (payload.op === "equals") return lower === needle;
        if (payload.op === "startsWith") return lower.startsWith(needle);
        if (payload.op === "contains") return lower.includes(needle);
        if (payload.op === "gt") return number !== null && reference !== null && number > reference;
        if (payload.op === "lt") return number !== null && reference !== null && number < reference;
        return false;
      });
      
      if (ok) {
        matches.push({
          modelKey: item.modelKey,
          modelName: item.modelName,
          dbId: item.dbId,
          name: item.name
        });
      }
    }
    self.postMessage({ action: "searchDone", matches });
    return;
  }
  
  if (action === "segmentation") {
    const groups = new Map();
    
    for (const item of items) {
      const property = item.properties.find(p => p.displayName === payload.propName);
      const value = String(property?.displayValue ?? "").trim() || "Sin asignar";
      
      if (!groups.has(value)) {
        groups.set(value, { elements: [], n: toNumber(value) });
      }
      
      groups.get(value).elements.push({
        modelKey: item.modelKey,
        modelName: item.modelName,
        dbId: item.dbId,
        name: item.name
      });
    }
    
    self.postMessage({ 
      action: "segmentDone", 
      groups: [...groups], 
      cacheKey: payload.cacheKey, 
      total: items.length 
    });
    return;
  }
  
  if (action === "qualityAudit") {
    const records = items.map(item => {
      const property = item.properties.find(p => p.displayName === payload.propName);
      return {
        modelKey: item.modelKey,
        modelName: item.modelName,
        dbId: item.dbId,
        name: item.name,
        value: String(property?.displayValue ?? "").trim()
      };
    });
    
    const filled = records.filter(x => x.value);
    const counts = new Map();
    filled.forEach(x => counts.set(x.value, (counts.get(x.value) || 0) + 1));
    
    let rows = [];
    
    if (payload.rule === "empty") {
      rows = records.filter(x => !x.value);
    } else if (payload.rule === "duplicates") {
      rows = filled
        .filter(x => counts.get(x.value) > 1)
        .map(x => ({ ...x, count: counts.get(x.value) }));
    } else if (payload.rule === "numeric") {
      rows = filled
        .map(x => ({ ...x, number: toNumber(x.value) }))
        .filter(x => x.number !== null)
        .sort((a, b) => a.number - b.number);
    } else {
      rows = [...counts]
        .map(([value, count]) => ({ value, count, isGroup: true }))
        .sort((a, b) => b.count - a.count);
    }
    
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
};