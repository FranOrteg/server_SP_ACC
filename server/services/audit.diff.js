// services/audit.diff.js
function norm(p = '') { return p.replace(/\\/g, '/'); }

function row(src, dst, state, action = null, notes = '') {
  return {
    path: src.path,
    src: { size: src.size, hash: src.hash, mtime: src.mtime, id: src.id },
    dst: dst ? { size: dst.size, hash: dst.hash, mtime: dst.mtime, urn: dst.urn } : { size: null, hash: null, mtime: null, urn: null },
    state, action, notes
  };
}

function decideEqual(s, d, policy) {
  const sizeEq  = (s.size != null && d.size != null) ? (Number(s.size) === Number(d.size)) : null;
  const hashEq  = (s.hash && d.hash) ? (s.hash === d.hash) : null;
  const mtimeEq = (s.mtime && d.mtime) ? (Math.abs(new Date(s.mtime) - new Date(d.mtime)) <= 2000) : null;

  if (policy === 'size_only') {
    if (sizeEq === true) return true;
    if (sizeEq === false) return 'SIZE_MISMATCH';
    return 'MTIME_DRIFT';
  }

  if (policy === 'size_and_time') {
    if (sizeEq === true && mtimeEq !== false) return true;
    if (sizeEq === false) return 'SIZE_MISMATCH';
    return 'MTIME_DRIFT';
  }

  if (policy === 'full_hash') {
    if (hashEq === true) return true;
    if (hashEq === false) return 'HASH_MISMATCH';
    if (sizeEq === true && mtimeEq !== false) return true;
    if (sizeEq === false) return 'SIZE_MISMATCH';
    return 'MTIME_DRIFT';
  }

  // auto
  if (hashEq !== null) return hashEq ? true : 'HASH_MISMATCH';
  if (sizeEq === false) return 'SIZE_MISMATCH';
  if (sizeEq === true && mtimeEq !== false) return true;
  return 'MTIME_DRIFT';
}

function buildDiff(sp, acc, hashPolicy = 'auto') {
  const idxAcc = new Map(acc.map(x => [norm(x.path), x]));
  const items = [];

  for (const s of sp) {
    const d = idxAcc.get(norm(s.path));
    if (!d) { items.push(row(s, null, 'MISSING_IN_ACC', 'UPLOAD')); continue; }

    const eq = decideEqual(s, d, hashPolicy);
    if (eq === true) items.push(row(s, d, 'OK'));
    else items.push(row(s, d, eq, eq === 'HASH_MISMATCH' ? 'OVERWRITE' : 'UPLOAD'));
  }

  return items;
}

module.exports = { buildDiff };
