// 前端纯渲染测试：在 Node 里 import 页面模块，喂给它服务端的真实数据，
// 检查每个页签都能产出结构正确、没有 undefined/NaN 的 HTML。
import test from 'node:test';
import assert from 'node:assert/strict';
import { freshDb } from './helpers.mjs';
import {
  previewPlan, comparePlans, openDemand, allWarehouses, allSkus, allLanes,
  inventoryBoard, reservationLoad, listPlans, listRecovery, eventLog, loadFacts,
} from '../src/planning.mjs';
import { currentDay } from '../src/inventory.mjs';

// 页面模块在 import 时会探测 DOM；给一个"没有元素"的最小 document 即可。
globalThis.document ??= {
  querySelector: () => null,
  querySelectorAll: () => [],
  getElementById: () => null,
};

const ui = await import('../public/app.js');

function bootstrapOf(db) {
  const day = currentDay(db);
  const facts = loadFacts(db, {});
  return {
    today: day,
    now: new Date().toISOString(),
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
  };
}

function assertClean(html, label) {
  assert.ok(html.length > 0, `${label} 渲染为空`);
  assert.ok(!html.includes('undefined'), `${label} 出现 undefined`);
  assert.ok(!html.includes('NaN'), `${label} 出现 NaN`);
  assert.ok(!html.includes('[object Object]'), `${label} 出现 [object Object]`);
}

test('概览与试算页签用真实数据渲染', async () => {
  const { db } = freshDb();
  ui.state.bootstrap = bootstrapOf(db);
  const central = previewPlan(db, { objective: 'central' });
  const phased = previewPlan(db, { objective: 'phased' });
  ui.state.preview = {
    central, phased, comparison: comparePlans(central, phased, { orders: central.orders }),
  };

  const overview = ui.renderOverview();
  assertClean(overview, '概览');
  assert.match(overview, /净水滤芯 K7/);
  assert.match(overview, /SO-2601/);

  const compare = ui.renderCompare();
  assertClean(compare, '试算比较');
  assert.match(compare, /集中求解/);
  assert.match(compare, /分阶段/);

  const result = ui.renderCompareResult(ui.state.preview);
  assertClean(result, '对比结果');
  assert.match(result, /成本/);
  assert.match(result, /缺货/);
});

test('方案页签渲染草稿、正式方案与占用表', async () => {
  const { db } = freshDb();
  ui.state.bootstrap = bootstrapOf(db);
  const { createPlan, commitPlan, getPlan } = await import('../src/planning.mjs');
  const draft = createPlan(db, { name: '草稿-集中', objective: 'central', scope: {}, actor: '林薇' });
  const official = createPlan(db, { name: '正式-分阶段', objective: 'phased', scope: {}, actor: '赵启明' });
  commitPlan(db, official.id, { actor: '赵启明' });

  ui.state.bootstrap = bootstrapOf(db);
  const list = ui.renderPlans();
  assertClean(list, '方案列表');
  assert.match(list, /草稿-集中/);
  assert.match(list, /正式-分阶段/);

  const detail = ui.renderPlanDetail(getPlan(db, draft.id));
  assertClean(detail, '草稿详情');
  assert.match(detail, /转正式/);

  const officialDetail = ui.renderPlanDetail(getPlan(db, official.id));
  assertClean(officialDetail, '正式详情');
  assert.match(officialDetail, /占用/);
  assert.match(officialDetail, /执行/);

  const execute = ui.renderExecute();
  assertClean(execute, '执行页');
  const recovery = ui.renderRecovery();
  assertClean(recovery, '恢复页');
});

test('转正式被拒时页面渲染冲突说明而不是崩溃', async () => {
  const { db } = freshDb();
  const { createPlan, commitPlan, PlanError } = await import('../src/planning.mjs');
  const a = createPlan(db, { name: 'A', objective: 'central', scope: {}, actor: '林薇' });
  const b = createPlan(db, { name: 'B', objective: 'phased', scope: {}, actor: '赵启明' });
  commitPlan(db, a.id, { actor: '林薇' });
  let err;
  try { commitPlan(db, b.id, { actor: '赵启明' }); } catch (e) { err = e; }
  assert.ok(err instanceof PlanError);
  ui.state.bootstrap = bootstrapOf(db);
  ui.state.planError = { message: err.message, code: err.code, detail: err.detail };
  const html = ui.renderPlanDetail((await import('../src/planning.mjs')).getPlan(db, b.id));
  assertClean(html, '冲突详情');
  assert.match(html, /超占|占用/);
});

test('转义：订单备注里的 HTML 不会注入页面', async () => {
  const { db } = freshDb();
  db.prepare("UPDATE orders SET note = '<img src=x onerror=alert(1)>' WHERE id = 'SO-2601'").run();
  ui.state.bootstrap = bootstrapOf(db);
  const html = ui.renderOverview();
  assert.ok(!html.includes('<img src=x'), '未转义的 HTML 进入了页面');
  assert.match(html, /&lt;img src=x/);
  assert.equal(ui.esc('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
});
