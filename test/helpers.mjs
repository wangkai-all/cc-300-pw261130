// 测试夹具：每个用例一个全新的内存库，种子数据即为页面上的本地虚构数据。
import { openDb } from '../src/app.mjs';
import { currentDay } from '../src/inventory.mjs';

export function freshDb() {
  const db = openDb(':memory:');
  return { db, today: currentDay(db) };
}

export function planAlloc(plan, demandId, { source = null } = {}) {
  return plan.allocations.filter(
    (a) => a.demand_id === demandId && (source == null || a.source_type === source),
  );
}

export function sumQty(rows) {
  return Math.round(rows.reduce((n, r) => n + Number(r.qty), 0) * 100) / 100;
}

export function reservationsOf(db, planId, kind = null) {
  return db.prepare(
    `SELECT * FROM reservations WHERE plan_id = ? ${kind ? 'AND kind = ?' : ''} ORDER BY id`,
  ).all(...(kind ? [planId, kind] : [planId]));
}

// 走 HTTP，验证从浏览器视角看到的接口契约
export async function withServer(fn) {
  const db = openDb(':memory:');
  const { createServer } = await import('../src/app.mjs');
  const server = createServer(db);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, path, body, actor = '林薇') => {
    // HTTP 头只能是 Latin-1，中文计划员名字放进请求体；GET 用默认计划员。
    const payload = method === 'GET'
      ? body
      : { ...(body ?? {}), actor: (body && body.actor) || actor };
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { 'content-type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    const json = await res.json();
    return { status: res.status, body: json };
  };
  try {
    return await fn({ db, base, call, server });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}
