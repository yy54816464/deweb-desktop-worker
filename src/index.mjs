import { verifyMessage } from 'ethers';
import { createTapeStore } from '@tapestore/client';
import { createRemoteSigner, developerKeyAuth, describeDeveloperKey, serversOfKey } from '@taperelay/client';

const IS_PRO_SELECTOR = '0x41b99a80';
const DEFAULT_XLAYER_RPCS = [
  'https://rpc.xlayer.tech',
  'https://xlayer.drpc.org',
  'https://196.rpc.thirdweb.com/'
];
const MAX_PROFILE_BYTES = 1536 * 1024;
const MAX_TOTAL_BYTES = 25 * 1024 * 1024;
const MAX_WALL_BYTES = 25 * 1024 * 1024;
// Leave headroom in the account-level D1 write quota for auth/rate-limit rows.
const TAPE_WRITE_BUDGET_DEFAULT = 500000;
function cloud(env) {
  const db = env.DB;
  if (!db) throw new Error('D1 binding missing');
  return {
    async getStrict(key, type) {
      const row = await db.prepare('SELECT value, expires_at FROM kv WHERE key = ?').bind(key).first();
      if (row && row.expires_at && Number(row.expires_at) < Date.now()) return null;
      if (!row) return null;
      const value = row.value;
      if (type === 'json') { try { return JSON.parse(value); } catch (e) { return null; } }
      if (type === 'arrayBuffer') {
        try { const bin = atob(value); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out.buffer; } catch (e) { return null; }
      }
      return value;
    },
    async get(key, type) {
      try { return await this.getStrict(key, type); } catch (e) { return null; }
    },
    async put(key, value, opts = {}) {
      let text;
      if (typeof value === 'string') text = value;
      else if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
        const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        text = btoa(bin);
      } else text = JSON.stringify(value);
      const expires = opts && opts.expirationTtl ? Date.now() + Number(opts.expirationTtl) * 1000 : null;
      await db.prepare('INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at').bind(key, text, expires).run();
    },
    async putIfAbsent(key, value, opts = {}) {
      const text = typeof value === 'string' ? value : JSON.stringify(value);
      const now = Date.now();
      const expires = opts && opts.expirationTtl ? now + Number(opts.expirationTtl) * 1000 : null;
      const r = await db.prepare(
        'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at ' +
        'WHERE kv.expires_at IS NOT NULL AND kv.expires_at <= ? RETURNING key'
      ).bind(key, text, expires, now).all();
      return !!(r && r.results && r.results.length);
    },
    async delete(key) {
      try { await db.prepare('DELETE FROM kv WHERE key = ?').bind(key).run(); } catch (e) {}
    },
    async deleteIfValue(key, value) {
      try { await db.prepare('DELETE FROM kv WHERE key = ? AND value = ?').bind(key, String(value)).run(); } catch (e) {}
    },
    async list(opts = {}) {
      const prefix = String(opts.prefix || '');
      const limit = Math.min(1000, Number(opts.limit) || 1000);
      const offset = Number(opts.cursor) || 0;
      const rs = await db.prepare('SELECT key FROM kv WHERE key LIKE ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY key LIMIT ? OFFSET ?').bind(prefix + '%', Date.now(), limit, offset).all();
      const results = (rs.results || []).map(r => ({ name: r.key }));
      return { keys: results, list_complete: results.length < limit, cursor: String(offset + results.length) };
    }
  };
}
let tapeCacheKey = '';
let tapeCache = null;
let tapeSignerKey = '';
let tapeSignerCache = null;
function tape(env) {
  const key = env.TAPERELAY_KEY;
  if (!key) return null;
  if (key !== tapeCacheKey) {
    tapeCacheKey = key;
    tapeCache = createTapeStore({ developerKey: key });
  }
  return tapeCache;
}
function tapeWallEnabled(env) { return !!env.TAPERELAY_KEY && String(env.TAPERELAY_WALLPAPER || '') === '1'; }
function tapeSigner(env) {
  const key = env.TAPERELAY_KEY;
  if (!key) return null;
  if (key !== tapeSignerKey) {
    tapeSignerKey = key;
    const auth = developerKeyAuth(key);
    const info = describeDeveloperKey(key);
    tapeSignerCache = { signer: createRemoteSigner({ auth, servers: serversOfKey(key), account: info.account }), account: info.account, servers: serversOfKey(key) };
  }
  return tapeSignerCache;
}
function pendingKeysFor(address) {
  return ['tapereg:profile:' + address, 'tapereg:wall:' + address + ':desktop', 'tapereg:wall:' + address + ':mobile', 'tapereg:' + address];
}

const TAPE_OWNER_PREFIX = 'tapeown:';
function tapeErr(code, message) { return Object.assign(new Error(message || code), { code }); }
async function tapeOwnPointerObjects(env, address) {
  const out = new Set();
  const ptrs = await Promise.all([
    cloud(env).getStrict('tapeprofile:' + address, 'json'),
    cloud(env).getStrict('tapewall:' + address + ':desktop', 'json'),
    cloud(env).getStrict('tapewall:' + address + ':mobile', 'json')
  ]);
  for (const ptr of ptrs) {
    if (!ptr) continue;
    if (Array.isArray(ptr.objects)) for (const h of ptr.objects) if (/^[0-9a-f]{64}$/.test(h)) out.add(h);
    if (typeof ptr.manifest === 'string' && /^[0-9a-f]{64}$/.test(ptr.manifest)) out.add(ptr.manifest);
  }
  return out;
}
async function tapeOwnerLookup(env, hashes) {
  const out = new Map();
  const list = [...new Set((Array.isArray(hashes) ? hashes : []).filter(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))];
  if (!list.length) return out;
  if (!env.DB) throw new Error('D1 binding missing');
  const placeholders = list.map(() => '?').join(',');
  const rs = await env.DB.prepare(
    'SELECT key, value FROM kv WHERE key IN (' + placeholders + ') AND (expires_at IS NULL OR expires_at > ?)'
  ).bind(...list.map(h => TAPE_OWNER_PREFIX + h), Date.now()).all();
  for (const row of rs.results || []) {
    const h = String(row.key || '').slice(TAPE_OWNER_PREFIX.length);
    if (/^[0-9a-f]{64}$/.test(h) && row.value) out.set(h, String(row.value));
  }
  return out;
}
async function tapeWriteBudget(env, cost) {
  const db = env.DB;
  if (!db) return true;
  const limit = Number(env.TAPE_WRITE_BUDGET || TAPE_WRITE_BUDGET_DEFAULT);
  if (!Number.isFinite(limit) || limit <= 0) return true;
  const need = Math.max(1, Number(cost) || 1);
  const day = new Date().toISOString().slice(0, 10);
  const key = 'tapewb:' + day;
  try {
    const row = await db.prepare('SELECT value FROM kv WHERE key = ?').bind(key).first();
    const used = Number(row && row.value) || 0;
    if (used + need > limit) return false;
    await db.prepare(
      'INSERT INTO kv (key, value, expires_at) VALUES (?, ?, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET ' +
      'value = CAST(CAST(kv.value AS INTEGER) + ? AS TEXT), expires_at = excluded.expires_at'
    ).bind(key, String(need), Date.now() + 2 * 86400000, need).run();
    return true;
  } catch (e) {
    // Never block uploads because the budget row itself is unavailable.
    return true;
  }
}

async function tapeClaimObjects(env, address, objects, hints, opts) {
  const store = cloud(env);
  const hintSet = hints instanceof Set ? hints : new Set(hints || []);
  const refreshOwned = !!(opts && opts.refreshOwned);
  const list = [...new Set((Array.isArray(objects) ? objects : []).filter(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))];
  const owners = await tapeOwnerLookup(env, list);
  const writeCount = list.reduce((n, h) => n + (owners.get(h) ? (refreshOwned ? 1 : 0) : 1), 0);
  const extra = Number(opts && opts.extraCost) || 0;
  if (writeCount + extra > 0) {
    if (!await tapeWriteBudget(env, writeCount + extra)) {
      throw tapeErr('write-budget', '云端写入额度今日已满，请稍后重试');
    }
  }
  for (const h of list) {
    const owner = owners.get(h);
    if (owner) {
      if (String(owner) !== address) throw tapeErr('object-not-owned', '对象不属于当前账号');
      // Do not rewrite the 30-day TTL on every sign: repeats turned each sign
      // into 10-30 D1 writes. Finish refreshes it once per real upload.
      if (refreshOwned) {
        try { await store.put(TAPE_OWNER_PREFIX + h, address, { expirationTtl: 30 * 24 * 3600 }); } catch (e) {}
      }
      continue;
    }
    if (!hintSet.has(h) && await tapeHasObject(env, h)) throw tapeErr('object-not-owned', '对象已存在且不属于当前账号');
    if (!await store.putIfAbsent(TAPE_OWNER_PREFIX + h, address, { expirationTtl: 30 * 24 * 3600 })) {
      const again = await store.getStrict(TAPE_OWNER_PREFIX + h);
      if (String(again || '') !== address) throw tapeErr('object-not-owned', '对象归属冲突');
    }
  }
  return true;
}

function validProfileKdf(kdf) {
  if (!kdf || typeof kdf.salt !== 'string') return false;
  if (!/^[A-Za-z0-9+/=]{16,128}$/.test(kdf.salt)) return false;
  const n = Number(kdf.iterations);
  return Number.isInteger(n) && n >= 100000 && n <= 500000;
}
function pendingReserve(p) {
  if (!p) return 0;
  // Reserve the declared file size, not size+4MiB capped by object count:
  // that made 24MiB wallpapers (about 26 objects) look like 26MiB and fail
  // the 25MiB quota before any upload started. Finish still enforces actual.
  const declared = Number(p.size) > 0 ? Number(p.size) : 0;
  return Math.min(declared, MAX_TOTAL_BYTES);
}
async function pendingReservedBytes(env, address, exceptKey) {
  let total = 0;
  for (const key of pendingKeysFor(address)) {
    if (key === exceptKey) continue;
    const p = await cloud(env).getStrict(key, 'json');
    total += pendingReserve(p);
  }
  return total;
}
async function releaseOldPending(env, address, pendingKey, newObjects) {
  const old = await cloud(env).getStrict(pendingKey, 'json');
  if (!old || !Array.isArray(old.objects) || !old.objects.length) return;
  const keep = await tapeOwnPointerObjects(env, address);
  for (const h of (Array.isArray(newObjects) ? newObjects : [])) {
    if (typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)) keep.add(h);
  }
  for (const key of pendingKeysFor(address)) {
    if (key === pendingKey) continue;
    const other = await cloud(env).getStrict(key, 'json');
    if (other && Array.isArray(other.objects)) for (const h of other.objects) keep.add(h);
  }
  const release = [...new Set(old.objects)].filter(h => /^[0-9a-f]{64}$/.test(h) && !keep.has(h));
  if (!release.length) return;
  try {
    const rr = await tapeReleaseObjects(env, address, release);
    if (rr.failed && rr.failed.length) await tapeRetryAdd(env, address, release);
  } catch (e) {}
}
async function tapeRegister(req, env, origin, address) {
  // One per-account operation lock shared with finish. Separate locks let a
  // register and a finish mutate the same pending/pointer concurrently.
  const lockKey = 'tapeop:' + address;
  const lockToken = randomHex(16);
  let acquired = false;
  try { acquired = await cloud(env).putIfAbsent(lockKey, lockToken, { expirationTtl: 180 }); }
  catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  if (!acquired) return json({ error: '同步进行中，请稍后重试', code: 'REGISTER_BUSY' }, 409, origin, env);
  try { return await tapeRegisterInner(req, env, origin, address); }
  finally { try { await cloud(env).deleteIfValue(lockKey, lockToken); } catch (e) {} }
}
async function tapeRegisterInner(req, env, origin, address) {
  let body;
  try { body = await readJson(req, 256 * 1024); } catch (e) { return err(e.message, 413, origin, env); }
  const kind = body.kind === 'wallpaper' ? 'wallpaper' : (body.kind === 'profile' ? 'profile' : '');
  if (body.owner && String(body.owner).toLowerCase() !== address) return err('账号与登录会话不一致', 409, origin, env);
  if (!kind) return err('kind 必须是 profile 或 wallpaper', 400, origin, env);
  const mode = body.mode === 'mobile' ? 'mobile' : (body.mode === 'desktop' ? 'desktop' : '');
  if (kind === 'wallpaper' && !mode) return err('wallpaper 需要 mode', 400, origin, env);
  const size = Number(body.size);
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_TOTAL_BYTES) return err('文件大小无效', 413, origin, env);
  if (kind === 'profile' && size > MAX_PROFILE_BYTES) return err('profile 超过 1.5MB', 413, origin, env);
  if (kind === 'wallpaper' && size > MAX_WALL_BYTES) return err('壁纸超过 25MB', 413, origin, env);
  const objects = Array.isArray(body.objects) ? body.objects : [];
  if (!objects.length || objects.length > maxObjectsForSize(size) || !objects.every(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h))) {
    return err('objects 数量/格式无效', 400, origin, env);
  }
  if (new Set(objects).size !== objects.length) return err('objects 不能重复', 400, origin, env);
  const m = await requireMember(address, env);
  if (!m.ok) return json({ error: '需要有效的 DeWEB 会员', code: 'MEMBERSHIP_REQUIRED' }, 403, origin, env);
  const pendingKey = kind === 'profile' ? 'tapereg:profile:' + address : 'tapereg:wall:' + address + ':' + mode;
  let usage;
  try { usage = await quotaUsage(env, address); } catch (e) { return err('云端配额读取失败，请重试', 503, origin, env); }
  let reserved = 0;
  try { reserved = await pendingReservedBytes(env, address, pendingKey); } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  const reserveNew = Math.min(size, MAX_TOTAL_BYTES);
  // Replacing a profile/wallpaper must not count the old copy twice. Finish
  // already subtracts oldBytes; admission must do the same.
  let oldBytes = 0;
  let currentRevision = 0;
  try {
    if (kind === 'profile') {
      const direct = await cloud(env).getStrict('tapeprofile:' + address, 'json');
      currentRevision = Number(direct && direct.revision) || 0;
      oldBytes = Number(direct && direct.bytes) || 0;
    } else {
      const prev = await cloud(env).getStrict('tapewall:' + address + ':' + mode, 'json');
      oldBytes = Number(prev && prev.bytes) || 0;
    }
  } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  const projected = Math.max(0, usage.used - oldBytes) + reserved + reserveNew;
  if (projected > MAX_TOTAL_BYTES) return quotaExceeded(origin, env, { profile: usage.profile, walls: usage.walls, used: projected, limit: MAX_TOTAL_BYTES });
  if (kind === 'profile' && body.revision != null && Number(body.revision) !== currentRevision) {
    return json({ error: '版本冲突', code: 'REVISION_CONFLICT', revision: currentRevision }, 409, origin, env);
  }
  let meta = null;
  if (kind === 'wallpaper') {
    const mime = String(body.mime || '').toLowerCase();
    if (!/^image\/(jpeg|png|webp)$/.test(mime)) return err('壁纸类型无效', 415, origin, env);
    if (body.iv != null && (typeof body.iv !== 'string' || body.iv.length > 64)) return err('IV 无效', 400, origin, env);
    meta = { mime, iv: body.iv || '', enc: 1 };
    if (body.aad === 'v2') meta.aad = 'v2';
  }
  const pending = { kind, mode, size, objects, revision: currentRevision, meta, createdAt: Date.now(), owner: address };
  if (!await tapeWriteBudget(env, 6)) {
    return json({ error: '云端写入额度今日已满，请稍后重试', code: 'WRITE_BUDGET' }, 503, origin, env);
  }
  try { await releaseOldPending(env, address, pendingKey, objects); } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  await tapeLedgerAdd(env, address, objects);
  await cloud(env).put(pendingKey, JSON.stringify(pending), { expirationTtl: 900 });
  try { await cloud(env).delete('tapereg:' + address); } catch (e) {}
  return json({ ok: true, kind, mode, size, maxBytes: MAX_TOTAL_BYTES }, 200, origin, env);
}
async function tapeFinish(req, env, origin, address) {
  const lockKey = 'tapeop:' + address;
  const lockToken = randomHex(16);
  let acquired = false;
  try { acquired = await cloud(env).putIfAbsent(lockKey, lockToken, { expirationTtl: 180 }); }
  catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  if (!acquired) return json({ error: '同步进行中，请稍后重试', code: 'FINISH_BUSY' }, 409, origin, env);
  try { return await tapeFinishInner(req, env, origin, address); }
  finally { try { await cloud(env).deleteIfValue(lockKey, lockToken); } catch (e) {} }
}
async function tapeStaleAt(env, address, pending) {
  let at = Number(await cloud(env).getStrict('cloudreset:' + address) || 0);
  if (pending.kind === 'wallpaper' && pending.mode) {
    at = Math.max(at, Number(await cloud(env).getStrict('wallreset:' + address + ':' + pending.mode) || 0));
  }
  return at;
}

async function abortStalePending(env, address, pendingKey, objs) {
  // Delete the stale pending first, then release only objects not referenced by
  // a newer pending or a current pointer (a re-upload may reuse hashes).
  await cloud(env).delete(pendingKey);
  let refs = null;
  try { refs = await tapePointerRefs(env, address); } catch (e) { refs = null; }
  if (!refs) return;
  const release = objs.filter(h => !refs.has(h));
  if (!release.length) return;
  try {
    const rr = await tapeReleaseObjects(env, address, release);
    if (rr.failed && rr.failed.length) await tapeRetryAdd(env, address, release);
  } catch (e) {}
}

async function tapeFinishInner(req, env, origin, address) {
  let body;
  try { body = await readJson(req, 4096); } catch (e) { return err(e.message, 400, origin, env); }
  const manifest = String(body.manifest || '');
  if (!/^[0-9a-f]{64}$/.test(manifest)) return err('manifest 无效', 400, origin, env);
  let pending = null;
  let pendingKey = '';
  for (const key of pendingKeysFor(address)) {
    let p = null;
    try { p = await cloud(env).getStrict(key, 'json'); } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
    if (p && Array.isArray(p.objects) && p.objects.includes(manifest)) { pending = p; pendingKey = key; break; }
  }
  if (!pending) return err('没有待完成的 TapeRelay 上传', 409, origin, env);
  if (pending.owner && String(pending.owner).toLowerCase() !== address) return err('账号与登录会话不一致', 409, origin, env);
  const objs = Array.isArray(pending.objects) ? [...new Set(pending.objects.filter(Boolean))] : [];
  if (!objs.length || objs.length !== pending.objects.length) return err('objects 重复或为空', 400, origin, env);
  if (objs.length > maxObjectsForSize(pending.size)) return err('objects 数量与大小不匹配', 400, origin, env);
  // Reject uploads that began before a full cloud reset or wallpaper delete.
  let staleAt;
  try { staleAt = await tapeStaleAt(env, address, pending); }
  catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  if (staleAt && Number(pending.createdAt || 0) < staleAt) {
    await abortStalePending(env, address, pendingKey, objs);
    return json({ error: '上传已被重置取消，请重新上传', code: 'RESET_STALE' }, 409, origin, env);
  }
  // register already requires membership; finish must too, or an expired
  // account could still complete a cloud write started while it was active.
  let member;
  try { member = await requireMember(address, env); }
  catch (e) { return err('会员服务暂不可用，请稍后重试', 503, origin, env); }
  if (!member.ok) return json({ error: '需要有效的 DeWEB 会员', code: 'MEMBERSHIP_REQUIRED', expiry: member.membership.expiry }, 403, origin, env);
  const pointerKey = pending.kind === 'profile' ? 'tapeprofile:' + address : 'tapewall:' + address + ':' + pending.mode;
  let previous = null;
  try { previous = await cloud(env).getStrict(pointerKey, 'json'); } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  try {
    const hints = await tapeOwnPointerObjects(env, address);
    if (Array.isArray(previous && previous.objects)) for (const h of previous.objects) hints.add(h);
    await tapeClaimObjects(env, address, objs, hints, { refreshOwned: true, extraCost: 4 });
  } catch (e) {
    if (e && e.code === 'write-budget') return json({ error: '云端写入额度今日已满，请稍后重试', code: 'WRITE_BUDGET' }, 503, origin, env);
    if (e && e.code === 'object-not-owned') return json({ error: 'object-not-owned', code: 'OBJECT_NOT_OWNED', message: '对象不属于当前账号' }, 403, origin, env);
    return err('对象归属校验失败，请重试', 503, origin, env);
  }
  let actualBytes = 0;
  for (const h of objs) {
    const n = await tapeObjectSize(env, h);
    if (n == null) {
      if (Date.now() - Number(pending.createdAt || 0) > 15 * 60 * 1000) {
        // Release while the owner rows still exist. Unclaiming first made the
        // cron unable to release these objects, leaving them orphaned forever.
        try {
          const rr = await tapeReleaseObjects(env, address, objs);
          if (rr.failed && rr.failed.length) await tapeRetryAdd(env, address, objs);
        } catch (e) {}
        await cloud(env).delete(pendingKey);
      }
      return err('对象尚未上传完成，请重试', 409, origin, env);
    }
    actualBytes += n;
  }
  if (actualBytes < pending.size || actualBytes > pending.size + 4 * 1024 * 1024) {
    try { const rr = await tapeReleaseObjects(env, address, objs); if (rr.failed.length) await tapeRetryAdd(env, address, objs); } catch (e) {}
    await cloud(env).delete(pendingKey);
    return err('对象大小与声明不一致', 400, origin, env);
  }
  // Declared size alone must not let a profile exceed its hard cap.
  if (pending.kind === 'profile' && actualBytes > MAX_PROFILE_BYTES) {
    try { const rr = await tapeReleaseObjects(env, address, objs); if (rr.failed.length) await tapeRetryAdd(env, address, objs); } catch (e) {}
    await cloud(env).delete(pendingKey);
    return err('profile 超过 1.5MB', 413, origin, env);
  }
  if (pending.kind === 'profile' && Number(pending.revision || 0) !== Number(previous && previous.revision || 0)) {
    return json({ error: '版本冲突', code: 'REVISION_CONFLICT', revision: Number(previous && previous.revision || 0) }, 409, origin, env);
  }
  if (pending.kind === 'wallpaper' && previous && Number(previous.updatedAt || 0) > Number(pending.createdAt || 0)) {
    return json({ error: '壁纸版本冲突', code: 'REVISION_CONFLICT' }, 409, origin, env);
  }
  let usage;
  try { usage = await quotaUsage(env, address); } catch (e) { return err('云端配额读取失败，请重试', 503, origin, env); }
  const oldBytes = previous && Number(previous.bytes) > 0 ? Number(previous.bytes) : 0;
  if (usage.used - oldBytes + actualBytes > MAX_TOTAL_BYTES) {
    try { const rr = await tapeReleaseObjects(env, address, objs); if (rr.failed.length) await tapeRetryAdd(env, address, objs); } catch (e) {}
    await cloud(env).delete(pendingKey);
    return quotaExceeded(origin, env, { profile: usage.profile, walls: usage.walls, used: usage.used - oldBytes + actualBytes, limit: MAX_TOTAL_BYTES });
  }
  const kdf = body.kdf && typeof body.kdf === 'object' ? { salt: String(body.kdf.salt || '').slice(0,128), iterations: Number(body.kdf.iterations) || 0 } : null;
  if (pending.kind === 'profile' && !validProfileKdf(kdf)) {
    try { const rr = await tapeReleaseObjects(env, address, objs); if (rr.failed.length) await tapeRetryAdd(env, address, objs); } catch (e) {}
    await cloud(env).delete(pendingKey);
    return err('profile KDF 无效，请重新设置云同步密码', 400, origin, env);
  }
  // Re-check right before the pointer write: a reset/delete may have landed
  // after the early check while we were doing claim/HEAD.
  let finalStale;
  try { finalStale = await tapeStaleAt(env, address, pending); }
  catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  if (finalStale && Number(pending.createdAt || 0) < finalStale) {
    await abortStalePending(env, address, pendingKey, objs);
    return json({ error: '上传已被重置取消，请重新上传', code: 'RESET_STALE' }, 409, origin, env);
  }
  await cloud(env).put(pointerKey, JSON.stringify({ manifest, kdf, objects: objs, bytes: actualBytes, kind: pending.kind, mode: pending.mode || null, meta: pending.meta || null, revision: pending.kind === 'profile' ? Number(pending.revision || 0) + 1 : undefined, updatedAt: Date.now() }));
  await tapeLedgerAdd(env, address, objs);
  await cloud(env).delete(pendingKey);
  let finalUsage = null;
  try { finalUsage = await quotaUsage(env, address); } catch (e) {} 
  if (previous && previous.manifest && previous.manifest !== manifest) {
    const keep = [manifest];
    let keepReadOk = true;
    if (pending.kind === 'profile') {
      for (const m of ['desktop', 'mobile']) {
        try {
          const w = await cloud(env).getStrict('tapewall:' + address + ':' + m, 'json');
          if (w && w.manifest) keep.push(w.manifest);
        } catch (e) { keepReadOk = false; }
      }
    } else {
      try {
        const p = await cloud(env).getStrict('tapeprofile:' + address, 'json');
        if (p && p.manifest) keep.push(p.manifest);
      } catch (e) { keepReadOk = false; }
      try {
        const other = await cloud(env).getStrict('tapewall:' + address + ':' + (pending.mode === 'desktop' ? 'mobile' : 'desktop'), 'json');
        if (other && other.manifest) keep.push(other.manifest);
      } catch (e) { keepReadOk = false; }
    }
    if (Array.isArray(previous.objects) && previous.objects.length) {
      const keepObjects = new Set(pending.objects || []);
      for (const h of keep) {
        try {
          const kp = await cloud(env).getStrict('tapeprofile:' + address, 'json');
          if (kp && kp.manifest === h && Array.isArray(kp.objects)) for (const x of kp.objects) keepObjects.add(x);
          for (const m of ['desktop', 'mobile']) {
            const kw = await cloud(env).getStrict('tapewall:' + address + ':' + m, 'json');
            if (kw && kw.manifest === h && Array.isArray(kw.objects)) for (const x of kw.objects) keepObjects.add(x);
          }
        } catch (e) { keepReadOk = false; }
      }
      const release = previous.objects.filter(h => !keepObjects.has(h));
      if (keepReadOk && release.length) {
        const rr = await tapeReleaseObjects(env, address, release, previous.objects);
        if (rr.failed.length) await tapeRetryAdd(env, address, release);
      }
    } else {
      await tapeDelete(env, previous.manifest, []);
    }
  }
  return json({ ok: true, manifest, bytes: actualBytes, kind: pending.kind, mode: pending.mode || null, meta: pending.meta || null, revision: pending.kind === 'profile' ? Number(pending.revision || 0) + 1 : undefined, quota: finalUsage }, 200, origin, env);
}
async function tapePut(env, bytes, name) {
  const t = tape(env);
  if (!t) return null;
  const up = await t.upload(bytes, { name, contentType: 'application/octet-stream', allowSecrets: true });
  if (!up || !up.manifest) throw new Error('TapeRelay upload returned no manifest');
  if (Array.isArray(up.stored) && up.stored.length < 2) throw new Error('TapeRelay stored fewer than 2 replicas');
  return { manifest: up.manifest, bytes: bytes.byteLength };
}
async function tapeGet(env, manifest) {
  const t = tape(env);
  if (!t || !manifest) return null;
  return t.read(manifest);
}
async function tapeDelete(env, manifest, keep = []) {
  const t = tape(env);
  if (!t || !manifest) return;
  try { await t.remove(manifest, { keep }); } catch (e) {}
}
async function tapeReleaseObjects(env, address, objects, hints) {
  const t = tape(env);
  const key = env.TAPERELAY_KEY;
  const result = { released: [], failed: [], skipped: [] };
  if (!t || !key || !Array.isArray(objects) || !objects.length) return result;
  const store = cloud(env);
  const hintSet = hints instanceof Set ? hints : new Set(hints || []);
  const list = [];
  for (const h of new Set(objects.filter(x => /^[0-9a-f]{64}$/.test(x)))) {
    const owner = await store.getStrict(TAPE_OWNER_PREFIX + h);
    if (owner === address) { list.push(h); continue; }
    if (!owner && hintSet.has(h)) { list.push(h); continue; }
    result.skipped.push(h);
  }
  if (!list.length) return result;
  const auth = developerKeyAuth(key);
  for (const server of t.servers) {
    try {
      for (let i = 0; i < list.length; i += 1000) await t.client.release(server, auth, list.slice(i, i + 1000));
      result.released.push(server);
    } catch (e) {
      const code = String(e && e.code || 'error');
      result.failed.push({ server, code });
      console.error('tape-release-failed', server, code);
    }
  }
  if (result.released.length && !result.failed.length) {
    for (const h of list) { try { await store.delete(TAPE_OWNER_PREFIX + h); } catch (e) {} }
  }
  return result;
}
async function tapeHasObject(env, hash) {
  const t = tape(env);
  if (!t || !/^[0-9a-f]{64}$/.test(hash)) return false;
  const hits = await Promise.all(t.servers.map(server => t.client.has(server, hash).then(Boolean).catch(() => false)));
  return hits.some(Boolean);
}
function maxObjectsForSize(size) {
  return Math.min(80, Math.ceil(Number(size) / (1024 * 1024)) + 8);
}
async function tapeObjectSize(env, hash) {
  const t = tape(env);
  if (!t || !/^[0-9a-f]{64}$/.test(hash)) return null;
  const results = await Promise.all(t.servers.map(async (server) => {
    try {
      const r = await t.client.request(server, { method: 'HEAD', path: '/v1/objects/' + hash });
      const n = Number(r.headers.get('content-length'));
      return r.status === 200 && Number.isFinite(n) && n >= 0 ? n : null;
    } catch (e) { return null; }
  }));
  for (const n of results) if (n != null) return n;
  return null;
}
const TAPE_GRACE_MS = 24 * 60 * 60 * 1000;
async function tapeLedgerAdd(env, address, objects, now = Date.now()) {
  const list = [...new Set((Array.isArray(objects) ? objects : []).filter(h => typeof h === 'string' && /^[0-9a-f]{64}$/.test(h)))];
  if (!list.length) return;
  // Immutable per-registration row: no read-modify-write, no lost ledger on a read error.
  const key = 'tapeobjreg:' + address + ':' + now.toString(36) + ':' + randomHex(4);
  await cloud(env).put(key, JSON.stringify({ objects: list, createdAt: now }), { expirationTtl: 7 * 24 * 3600 });
}
async function tapeRetryAdd(env, address, objects) {
  if (!Array.isArray(objects) || !objects.length) return;
  const key = 'taperetry:' + address;
  let q = null;
  try { q = await cloud(env).get(key, 'json'); } catch (e) {}
  const set = new Set(q && Array.isArray(q.objects) ? q.objects : []);
  for (const h of objects) if (/^[0-9a-f]{64}$/.test(h)) set.add(h);
  await cloud(env).put(key, JSON.stringify({ objects: [...set].slice(0, 2000), attempts: Number(q && q.attempts) || 0, updatedAt: Date.now() }), { expirationTtl: 7 * 24 * 3600 });
}
async function tapePointerRefs(env, address) {
  const refs = new Set();
  try {
    for (const key of pendingKeysFor(address)) {
      const pending = await cloud(env).getStrict(key, 'json');
      if (pending && Array.isArray(pending.objects)) for (const h of pending.objects) refs.add(h);
    }
  } catch (e) { throw new Error('taperelay refs pending unavailable'); }
  const ptrs = await Promise.all([
    cloud(env).getStrict('tapeprofile:' + address, 'json'),
    cloud(env).getStrict('tapewall:' + address + ':desktop', 'json'),
    cloud(env).getStrict('tapewall:' + address + ':mobile', 'json')
  ]);
  for (const ptr of ptrs) {
    if (ptr && Array.isArray(ptr.objects)) for (const h of ptr.objects) refs.add(h);
    if (ptr && ptr.manifest) refs.add(ptr.manifest);
  }
  return refs;
}
async function tapeCron(env) {
  const t = tape(env);
  if (!t) return { skipped: 'no-key' };
  const out = { retries: 0, ledgers: 0, released: 0, queued: 0 };
  // 1. release retry queue: collect first (safe with OFFSET pagination)
  let cursor;
  const retryKeys = [];
  do {
    const page = await cloud(env).list({ prefix: 'taperetry:', cursor });
    for (const k of page.keys) retryKeys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  for (const name of retryKeys) {
    let q = null;
    try { q = await cloud(env).getStrict(name, 'json'); } catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    if (!q || !Array.isArray(q.objects) || !q.objects.length) { try { await cloud(env).delete(name); } catch (e) {} continue; }
    const address = name.slice('taperetry:'.length);
    let refs;
    try { refs = await tapePointerRefs(env, address); } catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    const safe = q.objects.filter(h => !refs.has(h));
    if (!safe.length) { try { await cloud(env).delete(name); } catch (e) {} continue; }
    const r = await tapeReleaseObjects(env, address, safe);
    out.retries++;
    if (r.failed.length) {
      try { await cloud(env).put(name, JSON.stringify({ objects: safe, attempts: (Number(q.attempts) || 0) + 1, updatedAt: Date.now() }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {}
    } else {
      try { await cloud(env).delete(name); } catch (e) {}
      out.released += safe.length;
    }
  }
  // 2. legacy ledger reconciliation / orphan scan: collect first
  cursor = undefined;
  const legacyKeys = [];
  do {
    const page = await cloud(env).list({ prefix: 'tapeobjects:', cursor });
    for (const k of page.keys) legacyKeys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  for (const name of legacyKeys) {
    const address = name.slice('tapeobjects:'.length);
    let ledger = null;
    try { ledger = await cloud(env).getStrict(name, 'json'); } catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    if (!ledger || !ledger.objects || typeof ledger.objects !== 'object') { try { await cloud(env).delete(name); } catch (e) {} continue; }
    if (!Object.keys(ledger.objects).length) { try { await cloud(env).delete(name); } catch (e) {} continue; }
    let refs;
    try { refs = await tapePointerRefs(env, address); } catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    const now = Date.now();
    const candidates = [];
    const kept = {};
    for (const [h, at] of Object.entries(ledger.objects)) {
      if (!/^[0-9a-f]{64}$/.test(h)) continue;
      if (refs.has(h) || now - Number(at || 0) < TAPE_GRACE_MS) { kept[h] = at; continue; }
      candidates.push(h);
    }
    if (candidates.length) {
      const r = await tapeReleaseObjects(env, address, candidates);
      if (r.failed.length) await tapeRetryAdd(env, address, candidates);
      const still = new Set([...Object.keys(kept), ...candidates.filter(h => r.failed.length)]);
      const next = {};
      for (const h of still) next[h] = kept[h] || now;
      if (r.failed.length || Object.keys(next).length) {
        try { await cloud(env).put(name, JSON.stringify({ objects: next, updatedAt: now }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {}
      } else {
        try { await cloud(env).delete(name); } catch (e) {}
      }
      out.released += candidates.length;
      if (r.failed.length) out.queued += candidates.length;
    } else if (Object.keys(kept).length !== Object.keys(ledger.objects).length) {
      try { await cloud(env).put(name, JSON.stringify({ objects: kept, updatedAt: now }), { expirationTtl: 7 * 24 * 3600 }); } catch (e) {}
    }
    out.ledgers++;
  }
  // 3. immutable per-registration ledger rows
  // Collect first, then process: deleting while OFFSET-paginating skips rows.
  const regKeys = [];
  cursor = undefined;
  do {
    const page = await cloud(env).list({ prefix: 'tapeobjreg:', cursor });
    for (const k of page.keys) regKeys.push(k.name);
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  for (const name of regKeys) {
    let row = null;
    try { row = await cloud(env).getStrict(name, 'json'); }
    catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    if (!row || !Array.isArray(row.objects) || !row.objects.length) { try { await cloud(env).delete(name); } catch (e) {} continue; }
    if (Date.now() - Number(row.createdAt || 0) < TAPE_GRACE_MS) continue;
    const address = name.slice('tapeobjreg:'.length).split(':')[0];
    if (!/^0x[0-9a-f]{40}$/.test(address)) { try { await cloud(env).delete(name); } catch (e) {} continue; }
    // Extend TTL before doing network work; this row must survive failed runs.
    try { await cloud(env).put(name, JSON.stringify(row), { expirationTtl: 7 * 24 * 3600 }); }
    catch (e) { out.failed = (out.failed || 0) + 1; continue; }
    let refs;
    try { refs = await tapePointerRefs(env, address); }
    catch (e) { out.skipped = (out.skipped || 0) + 1; continue; }
    const candidates = row.objects.filter(h => /^[0-9a-f]{64}$/.test(h) && !refs.has(h));
    if (candidates.length) {
      // Ledger objects were registered by this address; pass them as hints so
      // never-claimed uploaded objects can be released instead of orphaned.
      const rr = await tapeReleaseObjects(env, address, candidates, new Set(candidates));
      if (rr.failed && rr.failed.length) {
        await tapeRetryAdd(env, address, candidates);
        out.queued += candidates.length;
        out.failed = (out.failed || 0) + 1;
        continue;
      }
      out.released += candidates.length;
    }
    try { await cloud(env).delete(name); } catch (e) { out.failed = (out.failed || 0) + 1; continue; }
    out.ledgers++;
  }
  if (out.failed || out.skipped || out.queued) console.warn('tape-cron-summary', JSON.stringify(out));
  return out;
}
const SESSION_TTL = 3600;
const NONCE_TTL = 300;
const MEMBERSHIP_TTL = 300;

function cfg(env, key, fallback) {
  const v = env[key];
  return (v == null || v === '') ? fallback : v;
}
function origins(env) {
  return cfg(env, 'ALLOWED_ORIGINS', 'https://app.dewebdesk.link,https://1-2-399.tapekit.org')
    .split(',').map(s => s.trim()).filter(Boolean);
}
function allowedOrigin(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || 'https://app.dewebdesk.link,https://1-2-399.tapekit.org').split(',').map(s => s.trim()).filter(Boolean);
  return !!origin && allowed.includes(origin);
}
function cors(origin, env) {
  const list = origins(env);
  const ok = origin && list.includes(origin);
  const h = {
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Wall-Enc, X-Wall-Mime, X-Wall-IV, X-Wall-Enc-Version',
    'Access-Control-Expose-Headers': 'X-Wall-Encrypted, X-Wall-Mime, X-Wall-IV, X-Wall-Enc-Version, X-Wall-Version',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (ok) {
    h['Access-Control-Allow-Origin'] = origin;
    h['Access-Control-Allow-Credentials'] = 'true';
  }
  return h;
}
function json(data, status, origin, env) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors(origin, env))
  });
}
function err(message, status, origin, env) {
  return json({ error: message || 'error' }, status || 400, origin, env);
}
function normAddress(a) {
  if (typeof a !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(a)) throw new Error('无效钱包地址');
  return a.toLowerCase();
}
function randomHex(bytes) {
  const b = new Uint8Array(bytes || 16);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}
function b64url(buf) {
  const bytes = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64url(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function clientIp(req) {
  return (req.headers.get('CF-Connecting-IP') || req.headers.get('X-Forwarded-For') || 'unknown').split(',')[0].trim();
}
async function rateLimit(env, bucket, key, max, windowSec) {
  // D1 single-statement atomic counter. Fail closed if D1 is unavailable.
  try {
    if (!env.DB) return false;
    const now = Date.now();
    const slot = Math.floor(now / (windowSec * 1000));
    const rowKey = bucket + ':' + key + ':' + slot;
    const expires = now + windowSec * 2000;
    const row = await env.DB.prepare(
      'INSERT INTO rate_limits (key, count, expires_at) VALUES (?, 1, ?) ' +
      'ON CONFLICT(key) DO UPDATE SET ' +
      'count = CASE WHEN rate_limits.expires_at <= ? THEN 1 ELSE rate_limits.count + 1 END, ' +
      'expires_at = CASE WHEN rate_limits.expires_at <= ? THEN excluded.expires_at ELSE rate_limits.expires_at END ' +
      'RETURNING count'
    ).bind(rowKey, expires, now, now).first();
    return !!(row && Number(row.count) <= max);
  } catch (e) {
    return false;
  }
}
async function rateLimitRead(env, bucket, key) {
  // Approximate limiter for read-only endpoints: Cloudflare binding if available,
  // otherwise the old Cache API limiter. Deliberately does not write D1.
  if (env.READ_RATE) {
    try { const r = await env.READ_RATE.limit({ key: bucket + ':' + key }); return !!(r && r.success); } catch (e) {}
  }
  try {
    const slot = Math.floor(Date.now() / 60000);
    const req = new Request('https://rate-limit.internal/' + encodeURIComponent(bucket + ':' + key + ':' + slot));
    const cache = caches.default;
    const hit = await cache.match(req);
    const current = hit ? Number(await hit.text()) || 0 : 0;
    if (current >= 120) return false;
    await cache.put(req, new Response(String(current + 1), { headers: { 'Cache-Control': 'max-age=120' } }));
    return true;
  } catch (e) { return true; }
}
async function rateLimitMember(env, key) {
  // Anonymous membership checks can write a D1 cache row on every miss.
  // Strict per-IP binding keeps the write rate bounded.
  if (env.MEMBER_RATE) {
    try { const r = await env.MEMBER_RATE.limit({ key }); return !!(r && r.success); } catch (e) { return true; }
  }
  return rateLimitRead(env, 'member-check-ip', key);
}
function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
function authMessage(address, nonce, issuedAt) {
  // Keep the original 5-line format. Android clients validate this exact
  // shape before opening the signer; Origin binding is enforced server-side
  // by comparing the stored nonce origin with the verify request origin.
  return 'DeWEB Cloud Sync\nAddress: ' + address + '\nNonce: ' + nonce + '\nIssued At: ' + new Date(issuedAt).toISOString() + '\nChain: BSC';
}
async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return b64url(sig);
}
function sessionSecret(env) {
  const secret = env.SESSION_SECRET;
  if (!secret || String(secret).length < 32) throw new Error('SESSION_SECRET 未配置或过短');
  return String(secret);
}
async function issueToken(address, env) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { sub: address, iat: now, exp: now + SESSION_TTL, jti: randomHex(16) };
  const p = b64url(new TextEncoder().encode(JSON.stringify(payload)));
  const secret = sessionSecret(env);
  return p + '.' + await hmac(secret, p);
}
async function verifyToken(token, env) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const secret = sessionSecret(env);
  const expect = await hmac(secret, parts[0]);
  if (!safeEqual(expect, parts[1])) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(unb64url(parts[0])));
    if (!payload || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    if (payload.jti) {
      try {
        const revoked = await cloud(env).getStrict('revoked:' + payload.jti, 'json');
        if (revoked) return null;
      } catch (e) { return null; }
    }
    return payload;
  } catch (e) { return null; }
}
function cookieToken(req) {
  try {
    const raw = req.headers.get('Cookie') || '';
    const m = raw.match(/(?:^|;\s*)__Host-deweb_session=([^;]+)/);
    return m ? decodeURIComponent(m[1]) : '';
  } catch (e) { return ''; }
}
async function authPayload(req, env) {
  // Session is the HttpOnly __Host cookie only. Legacy Bearer tokens are no
  // longer accepted: the current web client never stores one, and accepting a
  // script-readable token would undo the cookie-only hardening.
  const cookie = cookieToken(req);
  if (!cookie) return null;
  return await verifyToken(cookie, env);
}
async function auth(req, env) {
  const payload = await authPayload(req, env);
  return payload ? payload.sub : null;
}
async function logout(req, env, origin) {
  const payload = await authPayload(req, env);
  if (!payload) {
    const res = err('未登录', 401, origin, env);
    res.headers.append('Set-Cookie', '__Host-deweb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    res.headers.append('Set-Cookie', 'deweb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
    return res;
  }
  if (!await rateLimit(env, 'auth-logout', payload.sub, 30, 60)) return err('请求过于频繁', 429, origin, env);
  if (payload.jti) {
    const ttl = Math.max(1, Number(payload.exp) - Math.floor(Date.now() / 1000));
    try { await cloud(env).put('revoked:' + payload.jti, '1', { expirationTtl: ttl }); } catch (e) { return err('退出失败，请重试', 503, origin, env); }
  }
  const res = json({ ok: true }, 200, origin, env);
  res.headers.append('Set-Cookie', '__Host-deweb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  res.headers.append('Set-Cookie', 'deweb_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0');
  return res;
}
async function rpcCall(rpc, to, data) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 7000);
  try {
    const r = await fetch(rpc, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'DeWEB-Cloud/1.0' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
      signal: ctl.signal
    });
    if (!r.ok) throw new Error('RPC HTTP ' + r.status);
    const j = await r.json();
    if (j && j.error) throw new Error(j.error.message || 'RPC error');
    if (!j || typeof j.result !== 'string') throw new Error('RPC missing result');
    if (j.result === '0x') return BigInt(0);
    return BigInt(j.result);
  } finally { clearTimeout(timer); }
}
async function readProChain(rpcs, contract, data) {
  const settled = await Promise.allSettled(rpcs.map(rpc => rpcCall(rpc, contract, data)));
  let yes = 0, no = 0;
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    if (r.value !== 0n) yes++; else no++;
  }
  if (yes >= 2) return true;
  if (no >= 2) return false;
  throw new Error('会员 RPC 共识不足');
}
async function readMembership(address, env, writeCache) {
  const key = 'member:circuit:v1:' + address;
  try {
    const cached = await cloud(env).get(key, 'json');
    if (cached && cached.checkedAt) {
      const ttl = cached.active ? MEMBERSHIP_TTL : MEMBERSHIP_TTL;
      if (Date.now() - cached.checkedAt < ttl * 1000) {
        return { active: !!cached.active, source: cached.source || 'none', expiry: 0, checkedAt: cached.checkedAt };
      }
    }
  } catch (e) {}
  const rpcs = cfg(env, 'XLAYER_RPCS', '').split(',').map(s => s.trim()).filter(Boolean);
  const list = rpcs.length ? rpcs : DEFAULT_XLAYER_RPCS;
  const resolver = cfg(env, 'CIRCUIT_PRO_RESOLVER', '0xd86fBB4Db54FCc2F5Be19F699b020d614998f59f');
  const data = IS_PRO_SELECTOR + address.replace(/^0x/, '').padStart(64, '0');
  const active = await readProChain(list, resolver, data);
  const entry = { active: !!active, source: active ? 'circuit' : 'none', checkedAt: Date.now() };
  // Anonymous membership checks must not write D1 on every rotated address.
  if (writeCache !== false) {
    try { await cloud(env).put(key, JSON.stringify(entry), { expirationTtl: MEMBERSHIP_TTL }); } catch (e) {}
  }
  return entry;
}
function alphaFreeActive(env) {
  const until = Date.parse(cfg(env, 'ALPHA_FREE_PRO_UNTIL', ''));
  return Number.isFinite(until) && Date.now() < until;
}
async function requireMember(address, env) {
  let m = null;
  try { m = await readMembership(address, env); } catch (e) {
    if (!alphaFreeActive(env)) throw e;
  }
  if (m && m.active) return { ok: true, membership: m };
  if (alphaFreeActive(env)) {
    return { ok: true, membership: { active: true, source: 'alpha', alpha: true, expiry: Date.parse(cfg(env, 'ALPHA_FREE_PRO_UNTIL', '')) } };
  }
  return { ok: false, status: 403, membership: m || { active: false, source: 'none' } };
}
async function readJson(req, limit) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared > limit) throw new Error('内容过大');
  // Chunked requests can omit or understate Content-Length, so cap the stream
  // itself instead of buffering an arbitrarily large body first.
  const stream = req.body;
  if (!stream || typeof stream.getReader !== 'function') {
    const txt = await req.text();
    if (txt.length > limit) throw new Error('内容过大');
    try { return JSON.parse(txt || '{}'); } catch (e) { throw new Error('JSON 无效'); }
  }
  const reader = stream.getReader();
  const chunks = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > limit) throw new Error('内容过大');
      chunks.push(value);
    }
  } catch (e) {
    try { await reader.cancel(); } catch (_) {}
    throw e;
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const txt = new TextDecoder().decode(bytes);
  try { return JSON.parse(txt || '{}'); } catch (e) { throw new Error('JSON 无效'); }
}
async function nonce(req, env, origin) {
  // Keep the strict D1 per-IP limit. A Cache API limiter was tested and did
  // not enforce across colos; the 3-write cost is preferable to no limit.
  if (!await rateLimit(env, 'nonce-ip', clientIp(req), 60, 60)) return err('请求过于频繁', 429, origin, env);
  let body;
  try { body = await readJson(req, 4096); } catch (e) { return err(e.message, 413, origin, env); }
  let address;
  try { address = normAddress(body.address); } catch (e) { return err(e.message, 400, origin, env); }
  if (!await rateLimit(env, 'nonce-addr', address, 6, 60)) return err('请求过于频繁', 429, origin, env);
  const n = randomHex(16);
  const issuedAt = Date.now();
  const originTag = String(origin || '').toLowerCase().slice(0, 200);
  const message = authMessage(address, n, issuedAt);
  // One key per challenge. A single nonce:<address> key let anyone overwrite
  // another user's pending challenge and keep them from signing in.
  const key = 'nonce:' + address + ':' + n;
  try {
    await cloud(env).put(key, JSON.stringify({ nonce: n, message, issuedAt, origin: originTag }), { expirationTtl: NONCE_TTL });
  } catch (e) { console.error('nonce-put-failed', e && e.message, e && e.code); return err('登录服务暂时不可用，请稍后重试', 503, origin, env); }
  return json({ address, nonce: n, message, expiresIn: NONCE_TTL }, 200, origin, env);
}
async function verify(req, env, origin) {
  if (!await rateLimit(env, 'verify-ip', clientIp(req), 60, 60)) return err('请求过于频繁', 429, origin, env);
  let body;
  try { body = await readJson(req, 8192); } catch (e) { return err(e.message, 413, origin, env); }
  let address;
  try { address = normAddress(body.address); } catch (e) { return err(e.message, 400, origin, env); }
  if (!body.signature || typeof body.signature !== 'string') return err('缺少签名', 400, origin, env);
  if (!await rateLimit(env, 'verify-addr', address, 12, 60)) return err('请求过于频繁', 429, origin, env);
  const challenge = String(body.nonce || '');
  if (!/^[0-9a-f]{32}$/.test(challenge)) return err('登录挑战无效，请重试', 401, origin, env);
  const key = 'nonce:' + address + ':' + challenge;
  let stored = null;
  try { stored = await cloud(env).get(key, 'json'); } catch (e) {}
  if (!stored || stored.nonce !== challenge || Date.now() - stored.issuedAt > NONCE_TTL * 1000) return err('登录挑战已过期，请重试', 401, origin, env);
  // Bind a challenge to the origin that requested it when both sides report
  // one. Missing Origin (native/CLI clients) stays compatible.
  const currentOrigin = String(origin || '').toLowerCase();
  const storedOrigin = String(stored.origin || '').toLowerCase();
  if (storedOrigin && currentOrigin && storedOrigin !== currentOrigin) return err('登录挑战来源不匹配，请重试', 401, origin, env);
  let recovered;
  try { recovered = verifyMessage(stored.message, body.signature).toLowerCase(); } catch (e) { return err('签名格式无效', 401, origin, env); }
  if (recovered !== address) return err('签名地址不一致', 401, origin, env);
  try { await cloud(env).delete(key); } catch (e) {}
  let m;
  try { m = await requireMember(address, env); }
  catch (e) { return json({ error: '会员服务暂不可用', code: 'MEMBERSHIP_RPC_UNAVAILABLE' }, 503, origin, env); }
  if (!m.ok) return json({ error: '需要有效的 DeWEB 会员', code: 'MEMBERSHIP_REQUIRED', expiry: m.membership.expiry }, 403, origin, env);
  const token = await issueToken(address, env);
  const res = json({ address, expiresIn: SESSION_TTL, membership: { expiry: 0, active: true, source: m.membership.source || 'circuit' } }, 200, origin, env);
  res.headers.append('Set-Cookie', '__Host-deweb_session=' + encodeURIComponent(token) + '; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=' + SESSION_TTL);
  return res;
}
async function membership(req, env, origin, address, writeCache) {
  try {
    let m = null;
    try { m = await readMembership(address, env, writeCache); } catch (e) {
      if (!alphaFreeActive(env)) throw e;
    }
    if (m && m.active) return json({ address, expiry: 0, active: true, source: m.source || 'circuit', checkedAt: Date.now() }, 200, origin, env);
    if (alphaFreeActive(env)) return json({ address, expiry: Date.parse(cfg(env, 'ALPHA_FREE_PRO_UNTIL', '')), active: true, source: 'alpha', alpha: true, checkedAt: Date.now() }, 200, origin, env);
    return json({ address, expiry: 0, active: false, source: 'none', checkedAt: Date.now() }, 200, origin, env);
  } catch (e) { return err(e.message, 503, origin, env); }
}
async function quotaUsage(env, address) {
  const store = cloud(env);
  let profile = 0;
  const direct = await store.getStrict('tapeprofile:' + address, 'json');
  if (direct) profile = Math.max(0, Number(direct.bytes) || 0);
  let walls = 0;
  for (const mode of ['desktop', 'mobile']) {
    const tw = await store.getStrict('tapewall:' + address + ':' + mode, 'json');
    if (tw) walls += Math.max(0, Number(tw.bytes) || 0);
  }
  return { profile, walls, used: profile + walls, limit: MAX_TOTAL_BYTES };
}
function quotaExceeded(origin, env, usage) {
  return json({ error: '云空间已满（25MB）', code: 'QUOTA_EXCEEDED', quota: usage }, 413, origin, env);
}
// Reset intentionally stays auth-only (no membership gate): a user must always
// be able to erase their own cloud data, even after membership expiry.
async function cloudReset(env, origin, address) {
  const store = cloud(env);
  const resetAt = Date.now();
  // An upload started before this reset must not finish afterwards and
  // recreate a pointer. Finish checks pending.createdAt against this marker.
  try {
    await store.put('cloudreset:' + address, String(resetAt), { expirationTtl: 86400 });
  } catch (e) {
    return err('云端重置失败，请重试', 503, origin, env);
  }
  const keys = ['tapeprofile:' + address, 'profile:' + address, ...pendingKeysFor(address),
    'tapewall:' + address + ':desktop', 'tapewall:' + address + ':mobile',
    'wallmeta:' + address + ':desktop', 'wallmeta:' + address + ':mobile',
    'wall:' + address + ':desktop', 'wall:' + address + ':mobile'];
  const objects = new Set();
  const hints = new Set();
  const pointers = [];
  const pendingKeys = new Set(pendingKeysFor(address));
  for (const key of keys) {
    try {
      const v = await store.get(key, 'json');
      if (v && Array.isArray(v.objects)) { for (const h of v.objects) if (/^[0-9a-f]{64}$/.test(h)) { objects.add(h); if (!pendingKeys.has(key)) hints.add(h); } }
      if (v && v.manifest && /^[0-9a-f]{64}$/.test(v.manifest)) objects.add(v.manifest);
      if (v && v.tape && v.tape.manifest && /^[0-9a-f]{64}$/.test(v.tape.manifest)) objects.add(v.tape.manifest);
      pointers.push({ key, v });
    } catch (e) {}
  }
  for (const key of keys) {
    try { await store.delete(key); } catch (e) {}
  }
  try {
    const ledger = await store.getStrict('tapeobjects:' + address, 'json');
    if (ledger && ledger.objects && typeof ledger.objects === 'object') for (const h of Object.keys(ledger.objects)) if (/^[0-9a-f]{64}$/.test(h)) objects.add(h);
  } catch (e) {}
  try {
    const retry = await store.getStrict('taperetry:' + address, 'json');
    if (retry && Array.isArray(retry.objects)) for (const h of retry.objects) if (/^[0-9a-f]{64}$/.test(h)) objects.add(h);
  } catch (e) {}
  for (const mode of ['desktop', 'mobile']) { try { await delWall(env, 'wall:' + address + ':' + mode); } catch (e) {} }
  try { await store.delete('tapeobjects:' + address); } catch (e) {}
  try { await store.delete('taperetry:' + address); } catch (e) {}
  const list = [...objects];
  if (list.length) {
    try {
      const rr = await tapeReleaseObjects(env, address, list, hints);
      if (rr.failed && rr.failed.length) { console.error('reset-release-failed', JSON.stringify(rr.failed)); await tapeRetryAdd(env, address, list); }
    } catch (e) {}
  }
  return json({ ok: true, reset: true, released: list.length }, 200, origin, env);
}
async function profileGet(env, origin, address) {
  let p = { revision: 0, updatedAt: 0, data: null };
  let direct = null;
  try { direct = await cloud(env).getStrict('tapeprofile:' + address, 'json'); } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
  if (direct && direct.manifest) {
    // 控制面只返回指针；profile 文件由浏览器直读 TapeRelay，Worker 不代理。
    p = { revision: Number(direct.revision) || 0, updatedAt: Number(direct.updatedAt) || Date.now(), data: null, kdf: direct.kdf || null, tape: { manifest: direct.manifest, bytes: direct.bytes } };
  }
  p.quota = await quotaUsage(env, address);
  return json(p, 200, origin, env);
}
function validMode(v) { return v === 'desktop' || v === 'mobile'; }
async function delWall(env, key) {
  if (env.WALLPAPERS) await env.WALLPAPERS.delete(key);
  await cloud(env).delete(key);
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin, env) });
    }
    const path = url.pathname.replace(/\/+$/, '') || '/';
    if (['POST','PUT','DELETE','PATCH'].includes(request.method) && origin && !allowedOrigin(origin, env)) {
      return err('origin-not-allowed', 403, origin, env);
    }
    try {
      if (path === '/api/cron-status' && request.method === 'GET') {
        if (!await rateLimitRead(env, 'cron-status', clientIp(request))) return err('请求过于频繁', 429, origin, env);
        let last = null;
        try { last = await cloud(env).get('cron:last', 'json'); } catch (e) {}
        return json({ ok: true, last, note: 'cron is UTC 03:17 = Asia/Shanghai 11:17' }, 200, origin, env);
      }
      if (path === '/api/health') return json({ ok: true, service: 'deweb-cloud', time: Date.now() }, 200, origin, env);
      if (path === '/api/tape/register' && request.method === 'POST') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimit(env, 'tape-register', address, 30, 60)) return err('请求过于频繁', 429, origin, env);
        return await tapeRegister(request, env, origin, address);
      }
      if (path === '/api/tape/finish' && request.method === 'POST') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimit(env, 'tape-finish', address, 60, 60)) return err('请求过于频繁', 429, origin, env);
        return await tapeFinish(request, env, origin, address);
      }
      if (path === '/api/tape/wallpaper' && request.method === 'GET') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'tape-wallpaper-get', address)) return err('请求过于频繁', 429, origin, env);
        const mode = url.searchParams.get('mode') || '';
        if (!validMode(mode)) return err('mode 必须是 desktop 或 mobile', 400, origin, env);
        let ptr = null;
        try { ptr = await cloud(env).get('tapewall:' + address + ':' + mode, 'json'); } catch (e) {}
        if (!ptr) return err('没有 TapeRelay 壁纸', 404, origin, env);
        return json({ ok: true, manifest: ptr.manifest, bytes: ptr.bytes, meta: ptr.meta || null }, 200, origin, env);
      }
      if (path === '/api/tape/config' && request.method === 'GET') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'tape-config', address)) return err('请求过于频繁', 429, origin, env);
        const s = tapeSigner(env);
        if (!s) return json({ enabled: false, error: 'TAPERELAY_KEY 未配置' }, 503, origin, env);
        return json({ enabled: true, account: s.account, servers: s.servers, maxBytes: MAX_TOTAL_BYTES }, 200, origin, env);
      }
      if (path === '/api/tape/sign' && request.method === 'POST') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        // Read-rate binding, not D1: a D1 limiter row per sign was itself part
        // of the write amplification this route caused.
        if (!await rateLimitRead(env, 'tape-sign', address)) return err('请求过于频繁', 429, origin, env);
        const m = await requireMember(address, env);
        if (!m.ok) return json({ error: '需要有效的 DeWEB 会员', code: 'MEMBERSHIP_REQUIRED' }, 403, origin, env);
        const s = tapeSigner(env);
        if (!s) return json({ error: 'TAPERELAY_KEY 未配置' }, 503, origin, env);
        try {
          const body = await readJson(request, 256 * 1024);
          const checked = s.signer.check(body);
          const requested = new Set();
          for (const c of checked) if (c && Array.isArray(c.objects)) for (const h of c.objects) requested.add(h);
          let pending = null;
          for (const key of pendingKeysFor(address)) {
            let p = null;
            try { p = await cloud(env).getStrict(key, 'json'); } catch (e) { return json({ error: 'state-unavailable', message: '云端状态读取失败' }, 503, origin, env); }
            if (p && Array.isArray(p.objects) && [...requested].every(h => p.objects.includes(h))) { pending = p; break; }
          }
          if (!pending) return json({ error: 'missing-upload-registration', message: '还没有登记上传' }, 403, origin, env);
          const allowed = new Set(pending.objects || []);
          if (checked.some(c => c.kind !== 'upload' || !c.objects.every(h => allowed.has(h)))) {
            return json({ error: 'not-your-upload', message: '请求里有未登记的对象' }, 403, origin, env);
          }
          try {
            const hints = await tapeOwnPointerObjects(env, address);
            await tapeClaimObjects(env, address, [...requested], hints);
          } catch (e) {
            if (e && e.code === 'write-budget') return json({ error: '云端写入额度今日已满，请稍后重试', code: 'WRITE_BUDGET' }, 503, origin, env);
            if (e && e.code === 'object-not-owned') return json({ error: 'object-not-owned', message: '对象不属于当前账号' }, 403, origin, env);
            return json({ error: 'ownership-check-failed', message: '对象归属校验失败' }, 503, origin, env);
          }
          return json(await s.signer.sign(checked), 200, origin, env);
        } catch (e) {
          return json({ error: e?.code || 'remote-refused', message: String(e?.message || e) }, 403, origin, env);
        }
      }
      if (path === '/api/tape/status' && request.method === 'GET') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'tape-status', address)) return err('请求过于频繁', 429, origin, env);
        try {
          const t = tape(env);
          return json({ enabled: !!env.TAPERELAY_KEY, account: t ? t.account : null, servers: t ? t.servers : [] }, 200, origin, env);
        } catch (e) {
          return json({ enabled: !!env.TAPERELAY_KEY, error: String(e && e.message ? e.message : e) }, 200, origin, env);
        }
      }
      if (path === '/api/tape/selftest' && request.method === 'GET') {
        return err('selftest disabled', 410, origin, env);
      }
      if (path === '/api/auth/nonce' && request.method === 'POST') return await nonce(request, env, origin);
      if (path === '/api/auth/verify' && request.method === 'POST') return await verify(request, env, origin);
      if (path === '/api/auth/session' && request.method === 'GET') {
        const payload = await authPayload(request, env);
        if (!payload) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'auth-session', payload.sub)) return err('请求过于频繁', 429, origin, env);
        const res = json({ ok: true, address: payload.sub, expiresIn: Math.max(1, Number(payload.exp) - Math.floor(Date.now() / 1000)) }, 200, origin, env);
        return res;
      }
      if (path === '/api/auth/logout' && request.method === 'POST') return await logout(request, env, origin);
      if (path === '/api/membership/check' && request.method === 'GET') {
        const address = String(url.searchParams.get('address') || '').toLowerCase();
        if (!/^0x[0-9a-f]{40}$/.test(address)) return err('address 无效', 400, origin, env);
        if (!await rateLimitRead(env, 'member-check', address)) return err('请求过于频繁', 429, origin, env);
        if (!await rateLimitMember(env, clientIp(request))) return err('请求过于频繁', 429, origin, env);
        // Anonymous callers get a live answer but do not populate the D1 cache;
        // otherwise rotating addresses becomes an unbounded D1 write amplifier.
        let signed = null;
        try { signed = await authPayload(request, env); } catch (e) {}
        return await membership(request, env, origin, address, !!signed);
      }
      if (path === '/api/membership' && request.method === 'GET') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'membership', address)) return err('请求过于频繁', 429, origin, env);
        return await membership(request, env, origin, address);
      }
      if (path === '/api/cloud/reset' && request.method === 'POST') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimit(env, 'cloud-reset', address, 3, 60)) return err('请求过于频繁', 429, origin, env);
        return await cloudReset(env, origin, address);
      }
      if (path === '/api/profile' && request.method === 'GET') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        if (!await rateLimitRead(env, 'profile-get', address)) return err('请求过于频繁', 429, origin, env);
        return await profileGet(env, origin, address);
      }
      if (path === '/api/wallpaper' && request.method === 'DELETE') {
        const address = await auth(request, env);
        if (!address) return err('未登录', 401, origin, env);
        const mode = url.searchParams.get('mode') || '';
        if (!validMode(mode)) return err('mode 必须是 desktop 或 mobile', 400, origin, env);
        if (request.method === 'DELETE') {
          if (!await rateLimit(env, 'wall-delete', address, 10, 60)) return err('请求过于频繁', 429, origin, env);
          // A wallpaper upload started before this delete must not finish later
          // and recreate the pointer.
          try {
            await cloud(env).put('wallreset:' + address + ':' + mode, String(Date.now()), { expirationTtl: 86400 });
          } catch (e) { return err('云端状态读取失败，请重试', 503, origin, env); }
          let prev = null;
          try { prev = await cloud(env).getStrict('wallmeta:' + address + ':' + mode, 'json'); } catch (e) { return err('云端状态读取失败', 503, origin, env); }
          const tapeKey = 'tapewall:' + address + ':' + mode;
          let tapePrev = null;
          try { tapePrev = await cloud(env).getStrict(tapeKey, 'json'); } catch (e) { return err('云端状态读取失败', 503, origin, env); }
          await delWall(env, 'wall:' + address + ':' + mode);
          await cloud(env).delete('wallmeta:' + address + ':' + mode);
          await cloud(env).delete(tapeKey);
          try { await cloud(env).delete('tapereg:wall:' + address + ':' + mode); } catch (e) {}
          if (prev && prev.tape && prev.tape.manifest) {
            let keep = [];
            const other = await cloud(env).getStrict('wallmeta:' + address + ':' + (mode === 'desktop' ? 'mobile' : 'desktop'), 'json').catch(() => null);
            if (other && other.tape && other.tape.manifest) keep.push(other.tape.manifest);
            await tapeDelete(env, prev.tape.manifest, keep);
          }
          if (tapePrev && Array.isArray(tapePrev.objects) && tapePrev.objects.length) {
            let keep = new Set();
            const otherMode = mode === 'desktop' ? 'mobile' : 'desktop';
            try {
              const other = await cloud(env).getStrict('tapewall:' + address + ':' + otherMode, 'json');
              if (other && Array.isArray(other.objects)) for (const h of other.objects) keep.add(h);
            } catch (e) {}
            const release = tapePrev.objects.filter(h => !keep.has(h));
            if (release.length) {
              try { const rr = await tapeReleaseObjects(env, address, release, Array.isArray(tapePrev && tapePrev.objects) ? tapePrev.objects : []); if (rr.failed.length) await tapeRetryAdd(env, address, release); } catch (e) {}
            }
          }
          return json({ ok: true }, 200, origin, env);
        }
      }
      return err('not found', 404, origin, env);
    } catch (e) {
      return err(e && e.message ? e.message : 'server error', 500, origin, env);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil((async () => {
      try { if (env.DB) { await env.DB.prepare('DELETE FROM kv WHERE expires_at IS NOT NULL AND expires_at < ?').bind(Date.now()).run(); await env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(Date.now()).run(); } } catch (e) {}
      let cronOut = null; let cronErr = null;
      try { cronOut = await tapeCron(env); } catch (e) { cronErr = String(e && e.message || e); console.error('tape-cron-failed', cronErr); }
      try { await cloud(env).put('cron:last', JSON.stringify({ at: Date.now(), out: cronOut, error: cronErr }), { expirationTtl: 14 * 24 * 3600 }); } catch (e) {}
    })());
  }
};
