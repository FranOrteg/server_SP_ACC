// services/audit.diff.js

function normPath(p) {
  return String(p || '').normalize('NFC');
}

/**
 * Empareja listas planas de SP y ACC por path normalizado y
 * clasifica cada entrada: OK / MISSING_IN_ACC / SIZE_MISMATCH / HASH_MISMATCH / MTIME_DRIFT.
 *
 * Reglas:
 *  - Si hay hash en ambos: hash manda.
 *  - Si no hay hash en ambos pero hay size en ambos: size manda.
 *  - La diferencia de mtime NUNCA invalida si hash o size ya validan OK.
 *  - La deriva de mtime se añade como nota informativa cuando procede.
 *
 * @param {Array<{path:string,size?:number,hash?:string,mtime?:string,id?:string}>} spList
 * @param {Array<{path:string,size?:number,hash?:string,mtime?:string,urn?:string}>} accList
 * @param {'auto'|'size_only'|'hash_only'} hashPolicy
 * @param {{mtimePolicy?: 'ignore'|'informational'|'strict', mtimeSkewSec?: number}} opts
 */
function buildDiff(spList, accList, hashPolicy = 'auto', opts = {}) {
  const {
    mtimePolicy = 'informational',
    mtimeSkewSec = 120, // tolerancia 2 min por relojes/región
  } = opts;

  const accByPath = new Map();
  for (const a of accList || []) {
    accByPath.set(normPath(a.path), a);
  }

  const items = [];

  for (const s of spList || []) {
    const path = normPath(s.path);
    const a = accByPath.get(path);

    const src = { size: s.size ?? null, hash: s.hash ?? null, mtime: s.mtime ?? null, id: s.id ?? null };
    const dst = a
      ? { size: a.size ?? null, hash: a.hash ?? null, mtime: a.mtime ?? null, urn: a.urn ?? null }
      : { size: null, hash: null, mtime: null, urn: null };

    let state, action = 'UPLOAD', notes = '';

    if (!a) {
      state = 'MISSING_IN_ACC';
    } else {
      const haveBothHash = src.hash && dst.hash;
      const haveBothSize = Number.isFinite(src.size) && Number.isFinite(dst.size);

      // 1) Hash decide si ambos presentes o si la policy lo exige
      if ((hashPolicy === 'hash_only' || (hashPolicy === 'auto' && haveBothHash))) {
        if (haveBothHash) {
          if (src.hash === dst.hash) {
            state = 'OK';
          } else {
            state = 'HASH_MISMATCH';
          }
        } else {
          // no hay hash, caemos a size
          if (haveBothSize) {
            state = (src.size === dst.size) ? 'OK' : 'SIZE_MISMATCH';
          } else {
            state = decideByMtime(src, dst, mtimePolicy, mtimeSkewSec);
          }
        }
      }
      // 2) Size decide si policy es size_only o auto sin hash
      else if (hashPolicy === 'size_only' || hashPolicy === 'auto') {
        if (haveBothSize) {
          state = (src.size === dst.size) ? 'OK' : 'SIZE_MISMATCH';
        } else {
          state = decideByMtime(src, dst, mtimePolicy, mtimeSkewSec);
        }
      }
      // 3) último recurso por mtime
      else {
        state = decideByMtime(src, dst, mtimePolicy, mtimeSkewSec);
      }

      // Nota informativa de deriva temporal si procede y no afecta al estado OK
      if (state === 'OK' && src.mtime && dst.mtime) {
        const driftSec = Math.abs((new Date(dst.mtime) - new Date(src.mtime)) / 1000);
        if (driftSec > mtimeSkewSec) {
          notes = `mtime drift ${Math.round(driftSec)}s (SP=${src.mtime} vs ACC=${dst.mtime})`;
        }
      }
    }

    items.push({ path, src, dst, state, action, notes });
  }

  return items;
}

function decideByMtime(src, dst, mtimePolicy, skewSec) {
  const haveBothMtime = src.mtime && dst.mtime;
  if (!haveBothMtime) {
    // Sin hash ni size ni mtime fiable → no podemos validar: por prudencia, marcar como drift (no KO duro)
    return 'MTIME_DRIFT';
  }
  const driftSec = Math.abs((new Date(dst.mtime) - new Date(src.mtime)) / 1000);
  if (mtimePolicy === 'ignore') return 'OK';
  if (mtimePolicy === 'informational') {
    return (driftSec > skewSec) ? 'OK' : 'OK';
  }
  // strict
  return (driftSec > skewSec) ? 'MTIME_DRIFT' : 'OK';
}

module.exports = { buildDiff };
