// HTTP 端到端：真实服务 + fetch，覆盖演示故事线与错误契约。
import test from 'node:test';
import assert from 'node:assert/strict';
import { withServer } from './helpers.mjs';

test('首页与静态资源可访问，且是 ES module 页面', async () => {
  await withServer(async ({ call, base }) => {
    const html = await (await fetch(`${base}/`)).text();
    assert.match(html, /转运方案台/);
    assert.match(html, /type="module"/);
    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get('content-type'), /text\/css/);
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    const body = await js.text();
    assert.match(body, /function renderCompare/);
    const missing = await fetch(`${base}/nope.js`);
    assert.equal(missing.status, 404);
    void call;
  });
});

test('bootstrap 返回页面首屏需要的全部数据', async () => {
  await withServer(async ({ call }) => {
    const { status, body } = await call('GET', '/api/bootstrap');
    assert.equal(status, 200);
    assert.equal(body.today, '2026-11-16');
    assert.equal(body.warehouses.length, 4);
    assert.equal(body.skus.length, 2);
    assert.ok(body.orders.length >= 7);
    assert.ok(body.board.snapshot.length > 0);
    assert.ok(Array.isArray(body.plans));
    assert.ok(Array.isArray(body.events));
    const first = body.availability[0];
    for (const key of ['wh_id', 'sku_id', 'day', 'qty', 'gross', 'safety', 'reserved']) {
      assert.ok(key in first, `availability 缺少 ${key}`);
    }
  });
});

test('演示故事线：两人争货 -> 拒绝 -> 刷新 -> 只占剩余 -> 执行 -> 取消 -> 恢复 -> 回放', async () => {
  await withServer(async ({ call }) => {
    // 1. 双方试算（不落库）
    const preview = await call('POST', '/api/plans/preview', {});
    assert.equal(preview.status, 200);
    assert.ok(preview.body.central.metrics.cost.total > 0);
    assert.ok(preview.body.phased.metrics.cost.total > 0);
    assert.ok(preview.body.comparison.narrative.length > 0);
    assert.equal((await call('GET', '/api/plans')).body.plans.length, 0);

    // 2. 两人在彼此占用之前各自保存草稿：都以为同一批上海 K7 归自己
    const a = await call('POST', '/api/plans', { name: '林薇-集中', objective: 'central' }, '林薇');
    assert.equal(a.status, 201);
    const b = await call('POST', '/api/plans', { name: '赵启明-分阶段', objective: 'phased' }, '赵启明');
    assert.equal(b.status, 201);
    assert.equal((await call('GET', '/api/bootstrap')).body.plans.length, 2);

    // 3. 林薇先转正式
    const committedA = await call('POST', `/api/plans/${a.body.plan.id}/commit`, { actor: '林薇' });
    assert.equal(committedA.status, 200);
    assert.equal(committedA.body.plan.status, 'official');
    const resA = committedA.body.plan.reservations.filter((r) => r.kind === 'stock');
    assert.ok(resA.length > 0);

    // 4. 赵启明随后转正式：同一批货已被占用，拒绝
    const conflict = await call('POST', `/api/plans/${b.body.plan.id}/commit`, { actor: '赵启明' });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, 'OVERCOMMIT');
    assert.ok(conflict.body.detail.conflicts.length > 0);

    // 5. 刷新后按剩余资源重算并转正式
    const refreshed = await call('POST', `/api/plans/${b.body.plan.id}/refresh`, {}, '赵启明');
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.body.plan.status, 'draft');
    const commitB = await call('POST', `/api/plans/${b.body.plan.id}/commit`, { actor: '赵启明' });
    assert.equal(commitB.status, 200);
    assert.equal(commitB.body.plan.status, 'official');

    // 6. 概览中两方案并存，占用可见
    const boot = await call('GET', '/api/bootstrap');
    assert.equal(boot.body.plans.filter((p) => p.status === 'official').length, 2);
    assert.ok(boot.body.reservations.length > 0);

    // 7. 执行 B 的一行：库存流水出现，方案进度更新
    const allocA = commitB.body.plan.allocations.find((x) => x.source_type === 'local')
      ?? committedA.body.plan.allocations.find((x) => x.source_type === 'local');
    const exec = await call('POST', `/api/allocations/${allocA.id}/execute`, { qty: 5 }, '周航');
    assert.equal(exec.status, 200);
    assert.equal(exec.body.executed, 5);
    const events = await call('GET', '/api/events?limit=50');
    assert.ok(events.body.events.some((e) => e.kind === 'allocation.executed'));

    // 8. 取消订单 -> 释放占用 + 恢复任务
    const cancel = await call('POST', '/api/orders/SO-2601/cancel', { reason: '客户撤单' }, '周航');
    assert.equal(cancel.status, 200);
    assert.equal(cancel.body.order.status, 'cancelled');
    const recovery = await call('GET', '/api/recovery');
    assert.ok(recovery.body.tasks.some((t) => t.status === 'open'));

    // 9. 恢复任务生成草稿方案
    const task = recovery.body.tasks.find((t) => t.status === 'open');
    const recoveryPlan = await call('POST', `/api/recovery/${task.id}/plan`, { actor: '林薇' });
    assert.equal(recoveryPlan.status, 200);
    assert.equal(recoveryPlan.body.plan.status, 'draft');

    // 10. 回放：事件里有转正式、拒绝、执行、取消
    const kinds = new Set((await call('GET', '/api/events?limit=200')).body.events.map((e) => e.kind));
    for (const k of ['plan.committed', 'allocation.executed', 'order.cancelled', 'recovery.created']) {
      assert.ok(kinds.has(k), `回放缺少事件 ${k}`);
    }
    const planDetail = await call('GET', `/api/plans/${b.body.plan.id}`);
    const planKinds = planDetail.body.plan.events.map((e) => e.kind);
    assert.ok(planKinds.includes('created'));
    assert.ok(planKinds.includes('commit_rejected'));
    assert.ok(planKinds.includes('refreshed'));
    assert.ok(planKinds.includes('committed'));
  });
});

test('错误契约：未知方案 404、非法口径 422、非法数量 422', async () => {
  await withServer(async ({ call }) => {
    assert.equal((await call('GET', '/api/plans/NOPE')).status, 404);
    const badObj = await call('POST', '/api/plans', { name: 'x', objective: 'magic' });
    assert.equal(badObj.status, 422);
    assert.equal(badObj.body.code, 'BAD_OBJECTIVE');
    const noName = await call('POST', '/api/plans', { objective: 'central' });
    assert.equal(noName.status, 422);
    assert.equal(noName.body.code, 'NAME_REQUIRED');
    const plan = await call('POST', '/api/plans', { name: 'x', objective: 'central' });
    await call('POST', `/api/plans/${plan.body.plan.id}/commit`, {});
    const alloc = plan.body.plan.allocations.find((a) => a.source_type !== 'unmet');
    const badQty = await call('POST', `/api/allocations/${alloc.id}/execute`, { qty: 99999 });
    assert.equal(badQty.status, 422);
    assert.equal(badQty.body.code, 'BAD_QTY');
    const unknown = await call('POST', '/api/allocations/999999/execute', {});
    assert.equal(unknown.status, 404);
  });
});

test('到货更正与在途延误接口会变更事实并留下事件', async () => {
  await withServer(async ({ call }) => {
    const rc = await call('POST', '/api/receipts/RC-301/correct', { qty: 12, reason: '供应商少发' });
    assert.equal(rc.status, 200);
    assert.equal(rc.body.receipt.qty, 12);
    assert.equal(rc.body.receipt.revision, 1);
    const tr = await call('POST', '/api/transfers/TR-1001/delay', { delayDays: 2, reason: '暴雨' });
    assert.equal(tr.status, 200);
    assert.equal(tr.body.transfer.delay_days, 2);
    const arrived = await call('POST', '/api/transfers/TR-1001/arrive', {});
    assert.equal(arrived.status, 200);
    assert.equal(arrived.body.transfer.status, 'arrived');
    const events = (await call('GET', '/api/events?limit=100')).body.events.map((e) => e.kind);
    assert.ok(events.includes('receipt.corrected'));
    assert.ok(events.includes('transfer.delayed'));
    assert.ok(events.includes('transfer.arrived'));
  });
});

test('演示重置清空方案、占用与执行记录', async () => {
  await withServer(async ({ call }) => {
    const plan = await call('POST', '/api/plans', { name: 'x', objective: 'central' });
    await call('POST', `/api/plans/${plan.body.plan.id}/commit`, {});
    const reset = await call('POST', '/api/demo/reset', {});
    assert.equal(reset.status, 200);
    const boot = await call('GET', '/api/bootstrap');
    assert.equal(boot.body.plans.length, 0);
    assert.equal(boot.body.board.reservations.length, 0);
    assert.equal(boot.body.events.length, 1); // 只剩 seed 事件
    assert.equal(boot.body.today, '2026-11-16');
  });
});

test('可承诺量曲线与分阶段批次方案接口可用', async () => {
  await withServer(async ({ call }) => {
    const series = await call('GET', '/api/availability?wh=WH-WH&sku=SKU-K7&horizon=7');
    assert.equal(series.status, 200);
    assert.equal(series.body.series.length, 8);
    const first = series.body.series[0];
    assert.equal(first.day, '2026-11-16');
    assert.equal(first.free, first.projected - first.reserved);
    // 缺参数要报 400
    assert.equal((await call('GET', '/api/availability?wh=WH-WH')).status, 400);

    const batch = await call('POST', '/api/plans/phased-batch', {
      name: '分仓批次', whIds: ['WH-SH', 'WH-WH', 'WH-CD', 'WH-GZ'], stages: 2,
    });
    assert.equal(batch.status, 201);
    assert.equal(batch.body.stages.length, 2);
    assert.equal(batch.body.errors.length, 0);
    for (const p of batch.body.stages) {
      assert.equal(p.status, 'draft');
      assert.match(p.name, /阶段 \d/);
    }
    // 两个阶段只承诺各自范围内的订单，不重复
    const a = batch.body.stages[0];
    const b = batch.body.stages[1];
    const idsA = new Set(a.allocations.map((x) => x.demand_id));
    const idsB = new Set(b.allocations.map((x) => x.demand_id));
    for (const id of idsA) assert.ok(!idsB.has(id), `${id} 同时出现在两个阶段`);
  });
});
