// HTTP 服务：内置 node:http + node:sqlite，无第三方依赖。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { migrate, seed, TODAY } from './seed.mjs';
import {
  DataError, PlanError, previewPlan, createPlan, listPlans, getPlan, commitPlan,
  refreshPlan, revokePlan, executeAllocation, returnAllocation, cancelOrder,
  correctReceipt, arriveReceipt, delayTransfer, arriveTransfer, listRecovery, buildRecoveryPlan,
  dismissRecovery, createPhasedBatch, comparePlans, openDemand, allSkus,
  allWarehouses, allLanes, eventLog, inventoryBoard,
  availableByDay, reservationLoad, loadFacts,
} from './planning.mjs';
import { currentDay } from './inventory.mjs';
import { nowIso } from './dates.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '..', 'public');

export function openDb(file = process.env.DB_FILE || ':memory:') {
  const db = new DatabaseSync(file);
  if (file !== ':memory:') {
    // 文件数据库才需要 WAL 与超时；内存库给测试用
    db.exec('PRAGMA busy_timeout = 5000');
  }
  migrate(db);
  seed(db);
  return db;
}

class HttpError extends Error {
  constructor(status, message, code = 'BAD_REQUEST', detail) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
      if (raw.length > 1_000_000) reject(new HttpError(413, '请求体过大'));
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new HttpError(400, '请求体不是合法 JSON'));
      }
    });
  });
}

function actorFrom(req, body) {
  // 浏览器把中文计划员名放进 x-actor 时会 percent-encode（HTTP 头只允许 Latin-1）
  const raw = body?.actor || req.headers['x-actor'] || '林薇';
  let name = String(raw);
  try { name = decodeURIComponent(name); } catch { /* 原样使用 */ }
  return name.slice(0, 40);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const target = path.resolve(PUBLIC_DIR, `.${rel}`);
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  fs.readFile(target, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(target)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  });
}

// 把内部异常转成稳定的 API 错误
function toResponseError(err) {
  if (err instanceof HttpError) return { status: err.status, body: { error: err.message, code: err.code, detail: err.detail } };
  if (err instanceof DataError || err instanceof PlanError) {
    return { status: err.status ?? 409, body: { error: err.message, code: err.code, detail: err.detail } };
  }
  console.error(err);
  return { status: 500, body: { error: '服务器内部错误', code: 'INTERNAL' } };
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const { pathname } = url;
    try {
      if (!pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          throw new HttpError(405, '只支持 GET');
        }
        serveStatic(req, res, pathname);
        return;
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const actor = actorFrom(req, body);
      const day = currentDay(db);
      const route = `${req.method} ${pathname}`;

      // ---- 基础数据 ----
      if (route === 'GET /api/bootstrap') {
        const facts = loadFacts(db, {});
        return json(res, 200, {
          today: day,
          now: nowIso(),
          warehouses: allWarehouses(db),
          skus: allSkus(db),
          lanes: allLanes(db),
          orders: openDemand(db, { fromDay: day }),
          ordersAll: db.prepare(
            `SELECT o.*, w.name AS wh_name, s.name AS sku_name FROM orders o
              JOIN warehouses w ON w.id = o.wh_id JOIN skus s ON s.id = o.sku_id
              ORDER BY CASE o.status WHEN 'open' THEN 0 ELSE 1 END, o.due_at`,
          ).all(),
          board: inventoryBoard(db, day),
          availability: facts.availability,
          reservations: reservationLoad(db, day),
          plans: listPlans(db),
          recovery: listRecovery(db),
          events: eventLog(db, 120),
        });
      }
      if (route === 'GET /api/inventory') {
        const whId = url.searchParams.get('wh');
        const skuId = url.searchParams.get('sku');
        const board = inventoryBoard(db, day);
        return json(res, 200, {
          ...board,
          snapshot: whId ? board.snapshot.filter((r) => r.wh_id === whId) : board.snapshot,
          receipts: skuId ? board.receipts.filter((r) => r.sku_id === skuId) : board.receipts,
          transfers: skuId ? board.transfers.filter((r) => r.sku_id === skuId) : board.transfers,
        });
      }
      if (route === 'GET /api/availability') {
        const whId = url.searchParams.get('wh');
        const skuId = url.searchParams.get('sku');
        if (!whId || !skuId) throw new HttpError(400, '需要 wh 与 sku 参数');
        return json(res, 200, {
          wh_id: whId, sku_id: skuId, today: day,
          series: availableByDay(db, whId, skuId, day, Number(url.searchParams.get('horizon') ?? 14)),
        });
      }
      if (route === 'GET /api/orders') {
        return json(res, 200, {
          orders: db.prepare(
            `SELECT o.*, w.name AS wh_name, s.name AS sku_name FROM orders o
              JOIN warehouses w ON w.id = o.wh_id JOIN skus s ON s.id = o.sku_id
              ORDER BY CASE o.status WHEN 'open' THEN 0 ELSE 1 END, o.due_at`,
          ).all(),
        });
      }
      if (route === 'GET /api/events') {
        return json(res, 200, { events: eventLog(db, Number(url.searchParams.get('limit') ?? 200)) });
      }

      // ---- 方案试算 / 保存 ----
      if (route === 'POST /api/plans/preview') {
        const scope = body.scope ?? { whIds: body.whIds ?? [], skuIds: body.skuIds ?? [] };
        const a = previewPlan(db, { objective: 'central', scope });
        const b = previewPlan(db, { objective: 'phased', scope });
        return json(res, 200, {
          scope,
          central: a,
          phased: b,
          comparison: comparePlans(a, b, { orders: a.orders }),
        });
      }
      if (route === 'POST /api/plans') {
        const plan = createPlan(db, {
          name: body.name, objective: body.objective ?? 'central',
          scope: body.scope ?? { whIds: body.whIds ?? [], skuIds: body.skuIds ?? [] },
          actor, settings: body.settings,
        });
        return json(res, 201, { plan });
      }
      if (route === 'POST /api/plans/phased-batch') {
        const out = createPhasedBatch(db, {
          name: body.name ?? '分阶段批次', actor,
          whIds: body.whIds ?? [], skuIds: body.skuIds ?? [],
          stages: Number(body.stages ?? 2), objective: body.objective ?? 'phased',
        });
        return json(res, 201, out);
      }
      if (route === 'GET /api/plans') {
        return json(res, 200, { plans: listPlans(db) });
      }
      const planMatch = /^\/api\/plans\/([^/]+)$/.exec(pathname);
      if (planMatch && req.method === 'GET') {
        return json(res, 200, { plan: getPlan(db, planMatch[1]) });
      }
      const planAction = /^\/api\/plans\/([^/]+)\/(commit|refresh|revoke)$/.exec(pathname);
      if (planAction && req.method === 'POST') {
        const id = planAction[1];
        if (planAction[2] === 'commit') {
          return json(res, 200, { plan: commitPlan(db, id, { actor, expectedRowVersion: body.rowVersion }) });
        }
        if (planAction[2] === 'refresh') {
          return json(res, 200, { plan: refreshPlan(db, id, { actor }) });
        }
        return json(res, 200, { plan: revokePlan(db, id, { actor, reason: body.reason }) });
      }

      // ---- 执行 / 撤销 ----
      const execMatch = /^\/api\/allocations\/(\d+)\/(execute|return)$/.exec(pathname);
      if (execMatch && req.method === 'POST') {
        const id = Number(execMatch[1]);
        if (execMatch[2] === 'execute') {
          return json(res, 200, executeAllocation(db, id, {
            actor, qty: body.qty == null ? undefined : Number(body.qty), note: body.note, at: body.at,
          }));
        }
        return json(res, 200, returnAllocation(db, id, {
          actor, qty: body.qty == null ? undefined : Number(body.qty), reason: body.reason,
        }));
      }

      // ---- 事实变更 ----
      const orderCancel = /^\/api\/orders\/([^/]+)\/cancel$/.exec(pathname);
      if (orderCancel && req.method === 'POST') {
        return json(res, 200, { order: cancelOrder(db, orderCancel[1], { actor, reason: body.reason }) });
      }
      const receiptCorrect = /^\/api\/receipts\/([^/]+)\/correct$/.exec(pathname);
      if (receiptCorrect && req.method === 'POST') {
        return json(res, 200, {
          receipt: correctReceipt(db, receiptCorrect[1], {
            actor, qty: body.qty == null ? undefined : Number(body.qty), etaAt: body.etaAt, reason: body.reason,
          }),
        });
      }
      const receiptArrive = /^\/api\/receipts\/([^/]+)\/arrive$/.exec(pathname);
      if (receiptArrive && req.method === 'POST') {
        return json(res, 200, {
          receipt: arriveReceipt(db, receiptArrive[1], {
            actor, qty: body.qty == null ? undefined : Number(body.qty), at: body.at,
          }),
        });
      }
      const transferDelay = /^\/api\/transfers\/([^/]+)\/delay$/.exec(pathname);
      if (transferDelay && req.method === 'POST') {
        return json(res, 200, {
          transfer: delayTransfer(db, transferDelay[1], {
            actor, delayDays: Number(body.delayDays), reason: body.reason, newEta: body.newEta,
          }),
        });
      }
      const transferArrive = /^\/api\/transfers\/([^/]+)\/arrive$/.exec(pathname);
      if (transferArrive && req.method === 'POST') {
        return json(res, 200, {
          transfer: arriveTransfer(db, transferArrive[1], {
            actor, qty: body.qty == null ? undefined : Number(body.qty), at: body.at, note: body.note,
          }),
        });
      }

      // ---- 恢复任务 ----
      if (route === 'GET /api/recovery') {
        return json(res, 200, { tasks: listRecovery(db) });
      }
      const rec = /^\/api\/recovery\/([^/]+)\/(plan|dismiss)$/.exec(pathname);
      if (rec && req.method === 'POST') {
        if (rec[2] === 'plan') {
          return json(res, 200, { plan: buildRecoveryPlan(db, rec[1], { actor, objective: body.objective }) });
        }
        return json(res, 200, { task: dismissRecovery(db, rec[1], { actor, resolution: body.resolution }) });
      }

      if (route === 'POST /api/demo/reset') {
        seed(db, { reset: true });
        return json(res, 200, { ok: true, today: currentDay(db) });
      }
      if (route === 'GET /api/demo/scenario') {
        return json(res, 200, demoScenario(db));
      }

      throw new HttpError(404, `没有这个接口: ${req.method} ${pathname}`);
    } catch (err) {
      const { status, body: payload } = toResponseError(err);
      json(res, status, payload);
    }
  });
}

// 演示脚本：两个计划员争同一批货 -> 后转正式者被拒绝 -> 预约 -> 执行/取消/延误/回放
function demoScenario(db) {
  const day = currentDay(db);
  return {
    today: day,
    title: '两位计划员同时争用武汉 / 上海两仓的 K7 库存',
    story: [
      '林薇用集中口径保存方案 A：把武汉 K7 的 90 件留给缺货成本 40 元/件的 SO-2601，只把缺口留给上海的低成本订单。',
      '赵启明用分阶段口径保存方案 B：先按到期日满足上海的 SO-2602/2603（其中 30 件从武汉调拨），SO-2601 因此只剩 80 件。',
      '两张草稿都以为自己能拿到同一批库存；林薇先转正式后，赵启明再转正式会被判定超占（库存 / 需求槽位冲突）。',
      '刷新赵启明的草稿，只按剩余资源重算后即可转正式。',
      '之后可以部分执行、撤销剩余，或取消订单、更正到货、登记在途延误，观察占用释放与恢复任务，并在"执行与回放"里复盘。',
    ],
    keyStock: { wh_id: 'WH-WH', sku_id: 'SKU-K7', note: '武汉 K7 期初 140、安全库存 30；上海订单更早到期但缺货成本更低' },
  };
}

// 命令行直接运行时启动
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const file = process.env.DB_FILE || path.resolve(__dirname, '..', 'data.sqlite');
  const db = openDb(file);
  const port = Number(process.env.PORT || 3000);
  const server = createServer(db);
  server.listen(port, () => {
    console.log(`转运方案演示已启动: http://localhost:${port}  (数据库: ${file})`);
    console.log(`演示日期: ${TODAY}`);
  });
}
