/* 胶片修复与试映排期台
 * 纯前端应用：多卷工序排期、资源冲突/超期/循环依赖校验、
 * 版本锁定与差异、批量操作撤销、导入导出校验、双标签页三方合并。
 */

"use strict";

/* ============================================================
 * 常量
 * ==========================================================*/

const SCHED_KEY = "zfl17-film-restore-schedule";
const DESK_KEY = "zfl17-film-strip-desk";
const OP_KINDS = ["清洗", "修复", "接片", "试映"];
const PRIORITIES = [
  { value: 1, label: "高" },
  { value: 2, label: "中" },
  { value: 3, label: "低" }
];
const KIND_CLASS = { 清洗: "op-kind-clean", 接片: "op-kind-splice", 试映: "", 修复: "" };

const DEFAULT_DUR = { 清洗: 30, 修复: 60, 接片: 20, 试映: 45, 其他: 30 };
const KIND_COLOR = { 清洗: "#347d89", 修复: "#4d7656", 接片: "#d49b35", 试映: "#6d6378", 其他: "#697179" };
const PX_PER_MIN = 2; // 甘特图：每分钟 2px

/* ============================================================
 * 默认数据（沿用核对台片段）
 * ==========================================================*/

function uid(prefix) {
  if (window.crypto?.randomUUID) return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
  return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

function todayAt(hour, minute = 0) {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function defaultDoc() {
  const segments = [
    { id: uid("seg"), code: "A-001", duration: 18, shift: "正常", damage: "完好", note: "开场街景，节奏平稳。" },
    { id: uid("seg"), code: "A-006", duration: 9, shift: "偏红", damage: "轻微划痕", note: "人物近景左侧有划痕。" },
    { id: uid("seg"), code: "A-012", duration: 14, shift: "褪色", damage: "接片松动", note: "接片位置靠近段尾，放映前重新压平。" }
  ];

  const res = {
    wash: { id: uid("res"), name: "清洗台", kind: "设备" },
    lin: { id: uid("res"), name: "林师傅", kind: "人员" },
    screen: { id: uid("res"), name: "试映厅", kind: "设备" }
  };

  const reelId = uid("reel");
  const op = (kind, dur, deps, start, note) => ({
    id: uid("op"), reelId, kind, duration: dur, resourceId: null,
    dependsOn: deps, start, note: note || ""
  });
  // 不预选时间：由「自动排期」或用户排；这里给一组已经排好的示范
  const ops = [
    { ...op("清洗", 30, [], null, "A-006 有划痕，先清洗除尘"), resourceId: res.wash.id },
    { ...op("修复", 60, [], null, "A-006 偏红校正"), resourceId: res.lin.id },
    { ...op("接片", 20, [], null, "A-012 接片松动重接"), resourceId: res.lin.id },
    { ...op("试映", 45, [], null, "全卷连映核对"), resourceId: res.screen.id }
  ];
  ops[1].dependsOn = [ops[0].id]; // 修复 依赖 清洗
  ops[2].dependsOn = [ops[0].id]; // 接片 依赖 清洗
  ops[3].dependsOn = [ops[1].id, ops[2].id]; // 试映 依赖前两者

  const deadline = new Date();
  deadline.setHours(18, 0, 0, 0);

  return {
    origin: todayAt(9, 0),
    resources: [res.wash, res.lin, res.screen],
    segments,
    reels: [
      {
        id: reelId,
        name: "春日试映A卷",
        priority: 1,
        deadline: deadline.toISOString(),
        segmentCodes: ["A-001", "A-006", "A-012"],
        ops
      }
    ],
    versions: []
  };
}

/* ============================================================
 * 信封（envelope）：支持三方合并
 *   doc      —— 业务数据
 *   base     —— 本标签页上次已同步的基线快照
 *   revision —— 单调递增版本号
 *   resolved —— 已解决冲突签名，避免两个标签页再次报同一冲突
 * ==========================================================*/

let env = loadEnv();
let undoStack = []; // 仅保存最近一次批量操作
let pendingConflicts = []; // 合并产生、等待用户裁决的冲突

function loadEnv() {
  const saved = localStorage.getItem(SCHED_KEY);
  if (!saved) {
    const doc = defaultDoc();
    const e = { doc, base: clone(doc), revision: 1, resolved: [] };
    persistEnv(e, true);
    return e;
  }
  try {
    const parsed = JSON.parse(saved);
    if (!parsed.doc || !Array.isArray(parsed.doc.reels)) throw new Error("bad envelope");
    parsed.base = parsed.base || clone(parsed.doc);
    parsed.revision = Number(parsed.revision) || 1;
    parsed.resolved = Array.isArray(parsed.resolved) ? parsed.resolved : [];
    return parsed;
  } catch {
    const doc = defaultDoc();
    return { doc, base: clone(doc), revision: 1, resolved: [] };
  }
}

function persistEnv(target = env, silent = false) {
  try {
    localStorage.setItem(SCHED_KEY, JSON.stringify(target));
  } catch (err) {
    if (!silent) toast(`保存失败：${err.message}`, "error");
  }
}

function commitDoc(mutator, { batchLabel = null, snapshot = null } = {}) {
  const before = snapshot || clone(env.doc);
  const result = mutator ? mutator(env.doc) : undefined;
  // 注意：本地编辑不能重置 base —— base 是双标签页三方合并的共同祖先，
  // 只有在收到对端写入并合并之后才更新。
  env.revision += 1;
  persistEnv();
  if (batchLabel) {
    undoStack = [{ label: batchLabel, before, after: clone(env.doc) }];
  }
  renderAll();
  return result;
}

/* ============================================================
 * 工具
 * ==========================================================*/

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function allOps(doc = env.doc) {
  return doc.reels.flatMap((r) => r.ops.map((o) => ({ ...o, reelId: r.id })));
}

function findReel(reelId, doc = env.doc) {
  return doc.reels.find((r) => r.id === reelId);
}

function findOp(opId, doc = env.doc) {
  for (const reel of doc.reels) {
    const op = reel.ops.find((o) => o.id === opId);
    if (op) return { reel, op };
  }
  return null;
}

function resName(id) {
  return env.doc.resources.find((r) => r.id === id)?.name || "未分配";
}

function fmtClock(isoOrDate) {
  if (!isoOrDate) return "—";
  const d = typeof isoOrDate === "string" ? new Date(isoOrDate) : isoOrDate;
  if (Number.isNaN(d.getTime())) return "非法时间";
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function fmtDur(min) {
  const v = Math.max(0, Math.round(Number(min) || 0));
  return `${Math.floor(v / 60)}小时${String(v % 60).padStart(2, "0")}分`;
}

/** 仅保留安全的文件名字符，版本标识再不可信也不能写出路径分隔或控制符。 */
function safeFilePart(s) {
  return String(s ?? "").replace(/[^0-9A-Za-z一-鿿._-]/g, "_").slice(0, 40) || "version";
}

function dtLocalValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* ============================================================
 * 排期核心
 * ==========================================================*/

/** 卷内依赖环检测。返回环上的工序 id 集合，以及一个示例环路径。 */
function detectCycles(reel) {
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(reel.ops.map((o) => [o.id, WHITE]));
  const cycleNodes = new Set();
  const cycles = [];
  const stack = [];

  function dfs(id) {
    color.set(id, GRAY);
    stack.push(id);
    const op = reel.ops.find((o) => o.id === id);
    for (const depId of op.dependsOn || []) {
      if (!color.has(depId)) continue; // 悬空依赖由校验报告
      if (color.get(depId) === GRAY) {
        const start = stack.indexOf(depId);
        const path = stack.slice(start).concat(depId);
        cycles.push(path);
        path.forEach((p) => cycleNodes.add(p));
      } else if (color.get(depId) === WHITE) {
        dfs(depId);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  }

  for (const o of reel.ops) if (color.get(o.id) === WHITE) dfs(o.id);
  return { cycleNodes, cycles };
}

/**
 * 贪心 ASAP 自动排期：
 * 1) 卷按优先级（数字小为先），同级按截止时间；
 * 2) 卷内按依赖拓扑序，同层按工序表顺序；
 * 3) 每个资源维护占用区间，工序放到满足「不早于前序结束」的首个空档。
 * 未分配资源的工序不排（start=null），交校验报告。
 */
function autoSchedule(doc) {
  const next = clone(doc);
  // 清空已有时间，重新排
  for (const reel of next.reels) for (const op of reel.ops) op.start = null;

  const busy = new Map(); // resourceId -> [{start,end,opId}]
  next.resources.forEach((r) => busy.set(r.id, []));
  const originMs = new Date(next.origin).getTime();

  const orderedReels = [...next.reels].sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
  });

  for (const reel of orderedReels) {
    const { cycleNodes } = detectCycles(reel);
    // 拓扑序（Kahn），环上节点最后处理且不排
    const indeg = new Map();
    const byId = new Map(reel.ops.map((o) => [o.id, o]));
    for (const op of reel.ops) {
      indeg.set(op.id, (op.dependsOn || []).filter((d) => byId.has(d)).length);
    }
    const order = [];
    const queue = reel.ops.filter((o) => indeg.get(o.id) === 0).map((o) => o.id);
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const op of reel.ops) {
        if ((op.dependsOn || []).includes(id)) {
          indeg.set(op.id, indeg.get(op.id) - 1);
          if (indeg.get(op.id) === 0) queue.push(op.id);
        }
      }
    }

    for (const id of order) {
      const op = byId.get(id);
      if (!op.resourceId || !busy.has(op.resourceId) || cycleNodes.has(id)) continue;
      let earliest = originMs;
      for (const depId of op.dependsOn || []) {
        const dep = byId.get(depId);
        if (dep && dep.start != null) {
          earliest = Math.max(earliest, new Date(dep.start).getTime() + dep.duration * 60000);
        }
      }
      const intervals = busy.get(op.resourceId);
      let start = earliest;
      // 找首个不与任何区间重叠的位置
      let moved = true;
      while (moved) {
        moved = false;
        for (const iv of intervals) {
          const end = start + op.duration * 60000;
          if (start < iv.end && iv.start < end) {
            start = iv.end;
            moved = true;
          }
        }
      }
      op.start = new Date(start).toISOString();
      intervals.push({ start, end: start + op.duration * 60000, opId: id });
      intervals.sort((a, b) => a.start - b.start);
    }
  }
  return next;
}

/** 结束时间（ISO）或 null */
function opEnd(op) {
  if (op.start == null) return null;
  const t = new Date(op.start).getTime() + op.duration * 60000;
  return new Date(t).toISOString();
}

/**
 * 提交前校验。返回 { errors:[], warnings:[] }
 * 每个问题：{ level:'error'|'warn', code, reelId, opId?, message }
 */
function validate(doc) {
  const errors = [];
  const warnings = [];

  if (!doc.origin || Number.isNaN(new Date(doc.origin).getTime())) {
    errors.push({ level: "error", code: "BAD_ORIGIN", message: "工坊开门时间缺失或非法。" });
  }

  const validRes = new Set(doc.resources.map((r) => r.id));

  for (const reel of doc.reels) {
    const rname = reel.name || "未命名卷";
    if (!reel.deadline || Number.isNaN(new Date(reel.deadline).getTime())) {
      errors.push({ level: "error", code: "BAD_DEADLINE", reelId: reel.id, message: `「${rname}」的截止时间缺失或非法。` });
    }
    if (![1, 2, 3].includes(Number(reel.priority))) {
      errors.push({ level: "error", code: "BAD_PRIORITY", reelId: reel.id, message: `「${rname}」优先级非法。` });
    }

    const byId = new Map(reel.ops.map((o) => [o.id, o]));

    // 悬空依赖
    for (const op of reel.ops) {
      for (const depId of op.dependsOn || []) {
        if (!byId.has(depId)) {
          errors.push({
            level: "error", code: "MISSING_DEP", reelId: reel.id, opId: op.id,
            message: `「${rname} · ${op.kind}」依赖的工序已不存在（缺失依赖 ${depId.slice(-6)}）。`
          });
        }
      }
    }

    // 循环依赖
    const { cycleNodes, cycles } = detectCycles(reel);
    if (cycles.length) {
      const path = cycles[0].map((id) => byId.get(id)?.kind || id.slice(-4)).join(" → ");
      errors.push({
        level: "error", code: "CYCLE", reelId: reel.id,
        message: `「${rname}」存在循环依赖：${path}，无法决定先后顺序。`
      });
    }

    // 逐条工序
    for (const op of reel.ops) {
      const where = `「${rname} · ${op.kind}」`;
      if (!op.resourceId || !validRes.has(op.resourceId)) {
        errors.push({ level: "error", code: "NO_RESOURCE", reelId: reel.id, opId: op.id, message: `${where} 尚未分配人员或设备。` });
      }
      if (!(Number(op.duration) > 0)) {
        errors.push({ level: "error", code: "BAD_DURATION", reelId: reel.id, opId: op.id, message: `${where} 占用时长必须大于 0。` });
      }
      if (op.start == null) {
        if (!cycleNodes.has(op.id)) {
          errors.push({ level: "error", code: "UNSCHEDULED", reelId: reel.id, opId: op.id, message: `${where} 尚未安排开始时间（点「自动排期」或手动指定）。` });
        }
        continue;
      }
      const st = new Date(op.start);
      if (Number.isNaN(st.getTime())) {
        errors.push({ level: "error", code: "BAD_TIME", reelId: reel.id, opId: op.id, message: `${where} 的开始时间非法。` });
        continue;
      }
      if (doc.origin && st.getTime() < new Date(doc.origin).getTime()) {
        warnings.push({ level: "warn", code: "BEFORE_ORIGIN", reelId: reel.id, opId: op.id, message: `${where} 排在工坊开门时间之前，请确认是否加班。` });
      }
      // 前序约束
      for (const depId of op.dependsOn || []) {
        const dep = byId.get(depId);
        if (!dep || dep.start == null) continue;
        const depEnd = new Date(dep.start).getTime() + dep.duration * 60000;
        if (st.getTime() < depEnd) {
          errors.push({
            level: "error", code: "PRECEDENCE", reelId: reel.id, opId: op.id,
            message: `${where} 于 ${fmtClock(st)} 开始，但前序「${dep.kind}」最早 ${fmtClock(new Date(depEnd))} 才结束。`
          });
        }
      }
      // 超期
      if (reel.deadline && !Number.isNaN(new Date(reel.deadline).getTime())) {
        const endMs = st.getTime() + op.duration * 60000;
        if (endMs > new Date(reel.deadline).getTime()) {
          errors.push({
            level: "error", code: "OVERDUE", reelId: reel.id, opId: op.id,
            message: `${where} 结束于 ${fmtClock(new Date(endMs))}，晚于本卷截止 ${fmtClock(reel.deadline)}。`
          });
        }
      }
    }
  }

  // 资源重叠（跨卷检测）
  const byResource = new Map();
  for (const reel of doc.reels) {
    for (const op of reel.ops) {
      if (!op.resourceId || op.start == null) continue;
      const st = new Date(op.start).getTime();
      if (Number.isNaN(st)) continue;
      const en = st + op.duration * 60000;
      if (!byResource.has(op.resourceId)) byResource.set(op.resourceId, []);
      byResource.get(op.resourceId).push({ op, reel, st, en });
    }
  }
  for (const [resId, items] of byResource) {
    items.sort((a, b) => a.st - b.st);
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        const a = items[i], b = items[j];
        if (b.st >= a.en) break;
        if (a.st < b.en && b.st < a.en) {
          const rn1 = a.reel.name, rn2 = b.reel.name;
          errors.push({
            level: "error", code: "OVERLAP",
            reelId: a.reel.id, opId: a.op.id,
            otherReelId: b.reel.id, otherOpId: b.op.id, resourceId: resId,
            message: `资源「${resName(resId)}」时间重叠：${rn1}·${a.op.kind}（${fmtClock(new Date(a.st))}–${fmtClock(new Date(a.en))}）与 ${rn2}·${b.op.kind}（${fmtClock(new Date(b.st))}–${fmtClock(new Date(b.en))}）。`
          });
        }
      }
    }
  }

  return { errors, warnings };
}

/* ============================================================
 * 版本与差异
 * ==========================================================*/

function lockVersion(note) {
  const { errors } = validate(env.doc);
  if (errors.length) return { ok: false, errors };
  const snap = clone(env.doc);
  const label = `v${env.doc.versions.length + 1}`;
  env.doc.versions.push({
    id: uid("ver"),
    label,
    note: note || "",
    lockedAt: new Date().toISOString(),
    origin: snap.origin,
    resources: snap.resources,
    reels: snap.reels,
    revision: env.revision
  });
  env.revision += 1;
  persistEnv();
  renderAll();
  return { ok: true, label };
}

/** 比较两份文档（旧→新），生成人类可读差异行 */
function diffDocs(oldDoc, newDoc) {
  const lines = [];
  const oldRes = new Map(oldDoc.resources.map((r) => [r.id, r]));
  const newRes = new Map(newDoc.resources.map((r) => [r.id, r]));

  for (const [id, r] of newRes) {
    if (!oldRes.has(id)) lines.push({ kind: "add", text: `新增资源：${r.name}（${r.kind}）` });
    else if (oldRes.get(id).name !== r.name) lines.push({ kind: "chg", text: `资源改名：${oldRes.get(id).name} → ${r.name}` });
  }
  for (const [id, r] of oldRes) {
    if (!newRes.has(id)) lines.push({ kind: "del", text: `删除资源：${r.name}` });
  }

  const oldReels = new Map(oldDoc.reels.map((r) => [r.id, r]));
  const newReels = new Map(newDoc.reels.map((r) => [r.id, r]));

  for (const [id, reel] of newReels) {
    const before = oldReels.get(id);
    if (!before) {
      lines.push({ kind: "add", text: `新增胶片卷：${reel.name}（${reel.ops.length} 道工序）` });
      continue;
    }
    const pLabel = (p) => PRIORITIES.find((x) => x.value === Number(p))?.label || p;
    if (before.name !== reel.name) lines.push({ kind: "chg", text: `卷改名：${before.name} → ${reel.name}` });
    if (Number(before.priority) !== Number(reel.priority)) lines.push({ kind: "chg", text: `「${reel.name}」优先级：${pLabel(before.priority)} → ${pLabel(reel.priority)}` });
    if (new Date(before.deadline).getTime() !== new Date(reel.deadline).getTime()) {
      lines.push({ kind: "chg", text: `「${reel.name}」截止：${fmtClock(before.deadline)} → ${fmtClock(reel.deadline)}` });
    }
    const oldOps = new Map(before.ops.map((o) => [o.id, o]));
    const newOps = new Map(reel.ops.map((o) => [o.id, o]));
    for (const [oid, op] of newOps) {
      const ob = oldOps.get(oid);
      if (!ob) {
        lines.push({ kind: "add", text: `「${reel.name}」新增工序：${op.kind}（${op.duration}分，${resName(op.resourceId)}）` });
        continue;
      }
      const tag = `「${reel.name} · ${op.kind}」`;
      if (ob.kind !== op.kind) lines.push({ kind: "chg", text: `${tag} 类型：${ob.kind} → ${op.kind}` });
      if (Number(ob.duration) !== Number(op.duration)) lines.push({ kind: "chg", text: `${tag} 时长：${ob.duration}分 → ${op.duration}分` });
      if (ob.resourceId !== op.resourceId) lines.push({ kind: "chg", text: `${tag} 资源：${resName(ob.resourceId)} → ${resName(op.resourceId)}` });
      const oldStart = ob.start == null ? "未排" : fmtClock(ob.start);
      const newStart = op.start == null ? "未排" : fmtClock(op.start);
      if (oldStart !== newStart) lines.push({ kind: "chg", text: `${tag} 开始：${oldStart} → ${newStart}` });
      const dOld = [...(ob.dependsOn || [])].sort().join(",");
      const dNew = [...(op.dependsOn || [])].sort().join(",");
      if (dOld !== dNew) {
        const nm = (x) => reel.ops.find((o) => o.id === x)?.kind || before.ops.find((o) => o.id === x)?.kind || x.slice(-4);
        lines.push({
          kind: "chg",
          text: `${tag} 前序依赖：${(ob.dependsOn || []).map(nm).join("、") || "无"} → ${(op.dependsOn || []).map(nm).join("、") || "无"}`
        });
      }
    }
    for (const [oid, op] of oldOps) {
      if (!newOps.has(oid)) lines.push({ kind: "del", text: `「${reel.name}」删除工序：${op.kind}` });
    }
  }
  for (const [id, reel] of oldReels) {
    if (!newReels.has(id)) lines.push({ kind: "del", text: `删除胶片卷：${reel.name}` });
  }
  return lines;
}

/* ============================================================
 * 导入导出
 * ==========================================================*/

function buildExportDoc() {
  return {
    format: "film-restore-schedule",
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    origin: env.doc.origin,
    resources: env.doc.resources,
    reels: env.doc.reels,
    lockedVersions: env.doc.versions
  };
}

function exportSchedule() {
  const payload = buildExportDoc();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const name = `film-schedule-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("已导出当前排期与锁定版本。", "success");
}

/**
 * 校验导入文件。返回：
 *  { valid, errors:[{message}], warnings:[...], normalized }
 *  —— 重复 ID、缺失依赖、非法时间都会成为 error，阻止导入。
 */
function validateImport(raw) {
  const errors = [];
  const warnings = [];
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch (err) {
    return { valid: false, errors: [{ message: `不是合法的 JSON 文件：${err.message}` }], warnings };
  }
  if (!data || typeof data !== "object") {
    return { valid: false, errors: [{ message: "文件内容结构不正确。" }], warnings };
  }
  // 允许两种形态：整信封 / 导出对象
  const src = data.doc ? data.doc : data;
  if (!Array.isArray(src.reels) || !Array.isArray(src.resources)) {
    return { valid: false, errors: [{ message: "缺少 reels 或 resources 数组，无法识别为排期文件。" }], warnings };
  }
  if (src.format && src.format !== "film-restore-schedule") {
    warnings.push({ message: `文件格式标记为 ${src.format}，仍按排期文件尝试解析。` });
  }
  if (!src.origin || Number.isNaN(new Date(src.origin).getTime())) {
    errors.push({ message: "工坊开门时间（origin）缺失或非法。" });
  }

  const normalized = {
    origin: src.origin,
    resources: [],
    reels: [],
    versions: []
  };

  // 资源：重复 ID 检查 + 同名资源归并到同一标识
  const seenRes = new Set();
  const nameToCanonical = new Map(); // 同名（区分大小写、去空格）→ 保留的首个 id
  const resIdAlias = new Map();      // 被归并的旧 id → 规范 id
  let sameNameMerged = 0;
  for (const r of src.resources) {
    if (!r || typeof r !== "object" || !r.id || !r.name) {
      errors.push({ message: "存在缺少 id/name 的资源记录。" });
      continue;
    }
    if (seenRes.has(r.id)) {
      errors.push({ message: `资源 ID 重复：${r.id}（${r.name || ""}）。` });
      continue;
    }
    const nameKey = String(r.name).trim();
    if (nameToCanonical.has(nameKey)) {
      // 同名不同 id：统一到首个资源标识，引用稍后重映射，不允许留下未分配工序
      resIdAlias.set(r.id, nameToCanonical.get(nameKey));
      sameNameMerged++;
      seenRes.add(r.id);
      continue;
    }
    nameToCanonical.set(nameKey, r.id);
    seenRes.add(r.id);
    normalized.resources.push({ id: r.id, name: nameKey, kind: ["人员", "设备"].includes(r.kind) ? r.kind : "人员" });
  }
  if (sameNameMerged) {
    warnings.push({ message: `文件内 ${sameNameMerged} 个同名资源已统一到同一资源标识，相关工序不会变为未分配。` });
  }

  const reelIds = new Set();
  const opIds = new Set();

  for (const reel of src.reels) {
    if (!reel || !reel.id) {
      errors.push({ message: "存在缺少 id 的胶片卷。" });
      continue;
    }
    if (reelIds.has(reel.id)) {
      errors.push({ message: `胶片卷 ID 重复：${reel.id}（${reel.name || ""}）。` });
      continue;
    }
    reelIds.add(reel.id);
    if (!reel.name) warnings.push({ message: `卷 ${reel.id.slice(-6)} 没有名称。` });
    if (!reel.deadline || Number.isNaN(new Date(reel.deadline).getTime())) {
      errors.push({ message: `卷「${reel.name || reel.id.slice(-6)}」截止时间缺失或非法。` });
    }
    if (![1, 2, 3].includes(Number(reel.priority))) {
      errors.push({ message: `卷「${reel.name || reel.id.slice(-6)}」优先级非法（应为 1/2/3）。` });
    }
    const nr = {
      id: reel.id,
      name: String(reel.name || "未命名卷"),
      priority: Number(reel.priority) || 3,
      deadline: reel.deadline,
      segmentCodes: Array.isArray(reel.segmentCodes) ? reel.segmentCodes.map(String) : [],
      ops: []
    };
    for (const op of reel.ops || []) {
      if (!op || !op.id) {
        errors.push({ message: `卷「${nr.name}」中存在缺少 id 的工序。` });
        continue;
      }
      if (opIds.has(op.id)) {
        errors.push({ message: `工序 ID 重复：${op.id}（${op.kind || ""}），跨卷也不允许重复。` });
        continue;
      }
      opIds.add(op.id);
      if (!(Number(op.duration) > 0)) {
        errors.push({ message: `卷「${nr.name}」工序 ${op.id.slice(-6)} 时长非法（必须为正数）。` });
      }
      let opResId = op.resourceId || null;
      if (opResId && resIdAlias.has(opResId)) opResId = resIdAlias.get(opResId);
      if (opResId && !seenRes.has(opResId)) {
        errors.push({ message: `卷「${nr.name} · ${op.kind || op.id.slice(-6)}」引用了不存在的资源 ${opResId.slice(-6)}。` });
      }
      if (op.start != null && Number.isNaN(new Date(op.start).getTime())) {
        errors.push({ message: `卷「${nr.name} · ${op.kind || op.id.slice(-6)}」开始时间非法：${String(op.start).slice(0, 32)}。` });
      }
      nr.ops.push({
        id: op.id,
        kind: OP_KINDS.includes(op.kind) ? op.kind : "其他",
        duration: Number(op.duration) || 0,
        resourceId: opResId,
        dependsOn: Array.isArray(op.dependsOn) ? op.dependsOn : [],
        start: op.start ?? null,
        note: String(op.note || "")
      });
    }
    normalized.reels.push(nr);
  }

  // 缺失依赖（在所有 op id 收集完后统一查）
  for (const reel of normalized.reels) {
    for (const op of reel.ops) {
      for (const dep of op.dependsOn) {
        if (!opIds.has(dep)) {
          errors.push({ message: `卷「${reel.name} · ${op.kind}」依赖了不存在的工序 ${String(dep).slice(-6)}（缺失依赖）。` });
        }
      }
    }
    const { cycles } = detectCycles(reel);
    if (cycles.length) {
      const path = cycles[0].map((id) => reel.ops.find((o) => o.id === id)?.kind || id.slice(-4)).join(" → ");
      errors.push({ message: `卷「${reel.name}」存在循环依赖：${path}。` });
    }
  }

  // 与当前数据的重复（仅提示，不阻止；重复 id 会在导入时重新签发）
  const currentRes = new Set(env.doc.resources.map((r) => r.id));
  const currentReels = new Set(env.doc.reels.map((r) => r.id));
  let dupCount = 0;
  for (const id of reelIds) if (currentReels.has(id)) dupCount++;
  for (const r of normalized.resources) if (currentRes.has(r.id)) dupCount++;
  if (dupCount) warnings.push({ message: `检测到 ${dupCount} 个与当前排期重复的 ID，导入时将重新编号以避免覆盖。` });

  const versions = Array.isArray(src.lockedVersions ?? src.versions) ? (src.lockedVersions ?? src.versions) : [];
  const currentVerIds = new Set(env.doc.versions.map((v) => v.id));
  const currentVerLabels = new Set(env.doc.versions.map((v) => v.label));
  const fileVerIds = new Set();    // 本文件内已出现的内部 id
  const fileVerLabels = new Set(); // 本文件内已出现的可见标识
  for (const v of versions) {
    if (!v || !v.id || !v.label || !Array.isArray(v.reels)) {
      warnings.push({ message: "跳过了一个结构不完整的锁定版本。" });
      continue;
    }
    // 标识只作纯文本展示：拒绝控制字符与标签形态，长度受限
    const rawLabel = String(v.label);
    if (/[<>]|[\u0000-\u001F]|javascript:/i.test(rawLabel) || rawLabel.length > 40) {
      errors.push({ message: `锁定版本标识「${rawLabel.slice(0, 20)}」含非法字符或过长，导入被阻止。` });
      continue;
    }

    // id 与可见标识分别检查：四种重复都必须阻断，绝不 warning 后静默丢一份或覆盖
    const idDupCurrent = currentVerIds.has(v.id);
    const idDupFile = fileVerIds.has(v.id);
    const labelDupCurrent = currentVerLabels.has(rawLabel);
    const labelDupFile = fileVerLabels.has(rawLabel);
    const idDup = idDupCurrent || idDupFile;
    const labelDup = labelDupCurrent || labelDupFile;
    const joinWhere = (...parts) => parts.filter(Boolean).join("、");

    if (idDup && labelDup) {
      errors.push({
        message: `锁定版本完全重复：内部 id 与可见标识「${rawLabel}」均已存在（${joinWhere(
          idDupCurrent && "与当前库", idDupFile && "文件内重复 id",
          labelDupCurrent && "与当前库同标识", labelDupFile && "文件内同标识")}），拒绝静默丢弃或覆盖，导入被阻止。`
      });
      continue;
    }
    if (idDup) {
      // 仅内部 id 重复（标识不同）：两份记录声称同一不可变快照身份，也不能覆盖
      errors.push({
        message: `锁定版本内部 id 重复（${joinWhere(idDupCurrent && "与当前库", idDupFile && "文件内")}）：标识「${rawLabel}」与已有版本不同，拒绝覆盖已有版本，导入被阻止。`
      });
      continue;
    }
    if (labelDup) {
      errors.push({
        message: `锁定版本可见标识重复：「${rawLabel}」（${joinWhere(labelDupCurrent && "与当前库", labelDupFile && "文件内")}），同一版本号不允许两份记录，导入被阻止。`
      });
      continue;
    }

    fileVerIds.add(v.id);
    fileVerLabels.add(rawLabel);
    normalized.versions.push({
      ...v,
      label: rawLabel,
      note: typeof v.note === "string" ? v.note.slice(0, 500) : "",
      // 只保留白名单字段，防止版本内嵌异常结构
      id: v.id,
      lockedAt: v.lockedAt,
      origin: v.origin,
      resources: Array.isArray(v.resources) ? v.resources : [],
      reels: v.reels,
      revision: Number(v.revision) || 0
    });
  }

  // 结构与脏数据全部通过后，为所有来自文件的实体重签本应用生成的安全 id。
  // 外部 id 是攻击者可控字符串，绝不允许原样进入 data-* 属性、选择器或代码。
  if (!errors.length) reIdNormalized(normalized);

  return { valid: errors.length === 0, errors, warnings, normalized };
}

/** 给导入文档重签安全 id，并重写所有内部引用（资源/依赖）。 */
function reIdNormalized(n) {
  const resMap = new Map(n.resources.map((r) => [r.id, uid("res")]));
  n.resources.forEach((r) => { r.id = resMap.get(r.id); });

  const opMap = new Map();
  for (const reel of n.reels) {
    reel.id = uid("reel");
    for (const op of reel.ops) opMap.set(op.id, uid("op"));
  }
  for (const reel of n.reels) {
    for (const op of reel.ops) {
      op.id = opMap.get(op.id);
      if (op.resourceId && resMap.has(op.resourceId)) op.resourceId = resMap.get(op.resourceId);
      op.dependsOn = (op.dependsOn || [])
        .map((d) => opMap.get(d))
        .filter(Boolean); // 悬空依赖已在校验阶段拦截，这里再兜底
    }
  }
  for (const v of n.versions) v.id = uid("ver");
}

/**
 * 执行导入。normalize 阶段已经为全部外部实体重签了本应用生成的安全 id，
 * 这里只做两件事：
 *  1) 与当前库同名的资源统一到同一标识，导入工序改挂现有 id（不留未分配）；
 *  2) 追加卷与版本（版本标识重复已在校验阶段拦截）。
 * 整批可撤销。
 */
function applyImport(normalized) {
  const before = clone(env.doc);
  const imported = clone(normalized);

  // 同名资源 → 现有资源标识
  const resIdRemap = new Map();
  for (const r of imported.resources) {
    const sameName = env.doc.resources.find((x) => x.name === r.name);
    if (sameName) resIdRemap.set(r.id, sameName.id);
  }
  imported.resources = imported.resources.filter((r) => !resIdRemap.has(r.id));
  for (const reel of imported.reels) {
    for (const op of reel.ops) {
      if (op.resourceId && resIdRemap.has(op.resourceId)) {
        op.resourceId = resIdRemap.get(op.resourceId);
      }
    }
  }

  env.doc.resources = mergeResources(env.doc.resources, imported.resources);
  env.doc.reels = env.doc.reels.concat(imported.reels);
  const haveLabel = new Set(env.doc.versions.map((v) => v.label));
  const haveId = new Set(env.doc.versions.map((v) => v.id));
  for (const v of imported.versions) {
    if (haveId.has(v.id) || haveLabel.has(v.label)) continue; // 双保险
    env.doc.versions.push(v);
    haveId.add(v.id);
    haveLabel.add(v.label);
  }
  env.revision += 1;
  persistEnv();
  undoStack = [{ label: "导入排期", before, after: clone(env.doc) }];
  renderAll();
}

function mergeResources(a, b) {
  const out = [...a];
  const names = new Set(a.map((r) => r.name));
  for (const r of b) {
    if (!names.has(r.name)) {
      out.push(r);
      names.add(r.name);
    }
  }
  return out;
}

/* ============================================================
 * 双标签页：三方合并 base / local / remote
 * ==========================================================*/

/**
 * 把 doc 拍平成「以实体 ID 为键」的叶子映射：
 *   reel:{reelId}:{field}
 *   reel:{reelId}:op:{opId}:{field}
 *   res:{resId}:{field}
 *   origin
 * 用 ID 而不是数组下标，可避免实体增删后路径错位、把 A 的字段写到 B 上。
 */
function flattenDoc(doc) {
  const out = new Map();
  out.set("origin", JSON.stringify(doc.origin));
  for (const r of doc.resources || []) {
    for (const f of ["name", "kind"]) out.set(`res:${r.id}:${f}`, JSON.stringify(r[f]));
  }
  for (const reel of doc.reels || []) {
    for (const f of ["name", "priority", "deadline", "segmentCodes"]) {
      out.set(`reel:${reel.id}:${f}`, JSON.stringify(reel[f]));
    }
    for (const op of reel.ops || []) {
      for (const f of ["kind", "duration", "resourceId", "start", "dependsOn", "note"]) {
        out.set(`reel:${reel.id}:op:${op.id}:${f}`, JSON.stringify(op[f]));
      }
    }
  }
  return out;
}

/** 解析扁平路径并在给定 doc 中定位实体 */
function parsePath(path, doc) {
  if (path === "origin") return { type: "origin", label: "工坊开门时间", field: "origin" };
  let m = path.match(/^res:([^:]+):(.+)$/);
  if (m) {
    const res = (doc.resources || []).find((r) => r.id === m[1]);
    return { type: "res", resId: m[1], field: m[2], label: res ? `资源「${res.name}」的${fieldLabel(m[2])}` : path };
  }
  m = path.match(/^reel:([^:]+):op:([^:]+):(.+)$/);
  if (m) {
    const reel = (doc.reels || []).find((r) => r.id === m[1]);
    const op = reel?.ops.find((o) => o.id === m[2]);
    return {
      type: "op", reelId: m[1], opId: m[2], field: m[3],
      label: reel && op ? `「${reel.name} · ${op.kind}」的${fieldLabel(m[3])}` : path
    };
  }
  m = path.match(/^reel:([^:]+):(.+)$/);
  if (m) {
    const reel = (doc.reels || []).find((r) => r.id === m[1]);
    return { type: "reel", reelId: m[1], field: m[2], label: reel ? `卷「${reel.name}」的${fieldLabel(m[2])}` : path };
  }
  return { type: "raw", label: path };
}

/** 旧的分类/文案函数名保留为 parsePath 的薄封装 */
function classifyPath(path, doc) {
  return parsePath(path, doc);
}

function fieldLabel(f) {
  return {
    name: "名称", priority: "优先级", deadline: "截止时间", kind: "工序类型",
    duration: "占用时长", resourceId: "分配资源", start: "开始时间",
    dependsOn: "前序依赖", note: "备注", segmentCodes: "关联片段", title: "名称"
  }[f] || f;
}

function valueToText(info, valJson, doc) {
  const v = JSON.parse(valJson);
  if (info.field === "start") return v == null ? "未排" : fmtClock(v);
  if (info.field === "deadline" || info.field === "origin") return v == null ? "空" : fmtClock(v);
  if (info.field === "priority") return PRIORITIES.find((p) => p.value === Number(v))?.label || String(v);
  if (info.field === "resourceId") return v ? resName(v) : "未分配";
  if (info.field === "duration") return `${v} 分`;
  if (info.field === "dependsOn") {
    if (!Array.isArray(v) || !v.length) return "无依赖";
    const op = info.opId && findOp(info.opId, doc);
    const reel = op ? findReel(op.reelId, doc) : (info.reelId ? findReel(info.reelId, doc) : null);
    return v.map((id) => reel?.ops.find((o) => o.id === id)?.kind || id.slice(-4)).join("、");
  }
  if (v == null) return "空";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * 三方合并（base = 共同祖先，local = 本页，remote = 对端）。
 *  - 双方一致：直接采用；
 *  - 只有一方改：自动采用改动方（非冲突，静默合并）；
 *  - 双方都改且不同：登记冲突，交用户裁决，绝不静默覆盖。
 */
function threeWayMerge(baseDoc, localDoc, remoteDoc, resolvedSigs) {
  const conflicts = [];
  const autoApplied = [];
  const merged = clone(localDoc);
  const resolved = resolvedSigs || [];
  // 实体级冲突涉及的字段路径前缀，字段比对阶段跳过，避免同一改动报两遍
  const suppressedFieldPrefixes = [];

  const jsonEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const priorFor = (sig) => resolved.find((x) => x && x.sig === sig);

  const baseReelById = new Map(baseDoc.reels.map((r) => [r.id, r]));
  const remoteReelById = new Map(remoteDoc.reels.map((r) => [r.id, r]));
  const localReelIds = new Set(localDoc.reels.map((r) => r.id));

  function pushEntityConflict(c, reelId, restoreSource) {
    const withSource = { ...c, _keepSource: restoreSource };
    const prior = priorFor(c.sig);
    if (prior) {
      applyEntityDecision(merged, withSource, prior.value, restoreSource);
      suppressedFieldPrefixes.push(prior.value === "delete" ? `reel:${reelId}:` : `__none__:${reelId}`);
      return;
    }
    if (restoreSource && !merged.reels.some((r) => r.id === reelId)) {
      merged.reels.push(clone(restoreSource));
    }
    conflicts.push({ id: uid("cf"), entity: true, pick: null, ...withSource,
      _rawLocal: withSource.localAction, _rawRemote: withSource.remoteAction });
    suppressedFieldPrefixes.push(`reel:${reelId}:`);
  }

  /* ---------- 卷实体 ---------- */
  for (const br of baseDoc.reels) {
    const inLocal = localReelIds.has(br.id);
    const inRemote = remoteReelById.has(br.id);
    const localReel = inLocal ? localDoc.reels.find((r) => r.id === br.id) : null;
    const remoteReel = inRemote ? remoteReelById.get(br.id) : null;
    const localChanged = inLocal && !jsonEqual(localReel, br);
    const remoteChanged = inRemote && !jsonEqual(remoteReel, br);

    if (inLocal && !inRemote) {
      if (localChanged) {
        // 本页改了、对端删了 → 实体冲突
        pushEntityConflict({
          kind: "reel", sig: `entity:reel:${br.id}`, entityId: br.id,
          label: `卷「${localReel.name}」`,
          localAction: "keep", remoteAction: "delete",
          localText: `保留本页修改过的卷（${localReel.ops.length} 道工序）`,
          remoteText: "跟随另一标签页删除整卷",
          _keepSource: localReel
        }, br.id, localReel);
      } else {
        // 本页未动、对端删除 → 跟随删除，不自行恢复
        merged.reels = merged.reels.filter((r) => r.id !== br.id);
        autoApplied.push(`跟随另一标签页删除卷：${br.name}`);
      }
    } else if (!inLocal && inRemote && remoteChanged) {
      // 本页删了、对端改了 → 实体冲突（暂存对端版本供裁决）
      pushEntityConflict({
        kind: "reel", sig: `entity:reel:${br.id}`, entityId: br.id,
        label: `卷「${remoteReel.name}」`,
        localAction: "delete", remoteAction: "keep",
        localText: "跟随本页删除整卷",
        remoteText: `保留另一标签页修改过的卷（${remoteReel.ops.length} 道工序）`,
        _keepSource: remoteReel
      }, br.id, remoteReel);
    }
  }

  // 对端新增的卷（base 中没有）→ 并入
  for (const rr of remoteDoc.reels) {
    if (!baseReelById.has(rr.id) && !localReelIds.has(rr.id)) {
      merged.reels.push(clone(rr));
      autoApplied.push(`并入另一标签页新增的卷：${rr.name}`);
    }
  }

  /* ---------- 卷内工序实体 ---------- */
  for (const baseReel of baseDoc.reels) {
    const remoteReel = remoteReelById.get(baseReel.id);
    const localReel = localDoc.reels.find((r) => r.id === baseReel.id);
    const mergedReel = merged.reels.find((r) => r.id === baseReel.id);
    if (!remoteReel || !localReel || !mergedReel) continue;
    const baseOps = new Map(baseReel.ops.map((o) => [o.id, o]));
    const localOps = new Map(localReel.ops.map((o) => [o.id, o]));
    const remoteOps = new Map(remoteReel.ops.map((o) => [o.id, o]));

    for (const [opId, bop] of baseOps) {
      const lop = localOps.get(opId);
      const rop = remoteOps.get(opId);
      const localChanged = lop && !jsonEqual(lop, bop);
      const remoteChanged = rop && !jsonEqual(rop, bop);

      if (lop && !rop) {
        if (localChanged) {
          const c = {
            kind: "op", sig: `entity:op:${opId}`,
            reelId: baseReel.id, entityId: opId,
            label: `「${localReel.name} · ${lop.kind}」工序`,
            localAction: "keep", remoteAction: "delete",
            localText: "保留本页修改过的工序", remoteText: "跟随另一标签页删除该工序",
            _keepSource: lop
          };
          const prior = priorFor(c.sig);
          if (prior) { applyEntityDecision(merged, c, prior.value, lop); }
          else conflicts.push({ id: uid("cf"), entity: true, pick: null, ...c,
            _rawLocal: "keep", _rawRemote: "delete" });
        } else {
          mergedReel.ops = mergedReel.ops.filter((o) => o.id !== opId);
          autoApplied.push(`跟随另一标签页删除工序：${localReel.name} · ${lop.kind}`);
        }
        suppressedFieldPrefixes.push(`reel:${baseReel.id}:op:${opId}:`);
      } else if (!lop && rop && remoteChanged) {
        const c = {
          kind: "op", sig: `entity:op:${opId}`,
          reelId: baseReel.id, entityId: opId,
          label: `「${localReel.name} · ${rop.kind}」工序`,
          localAction: "delete", remoteAction: "keep",
          localText: "跟随本页删除该工序", remoteText: "保留另一标签页修改过的工序",
          _keepSource: rop
        };
        const prior = priorFor(c.sig);
        if (!mergedReel.ops.some((o) => o.id === opId) && (!prior || prior.value === "keep")) mergedReel.ops.push(clone(rop));
        if (!prior) {
          conflicts.push({ id: uid("cf"), entity: true, pick: null, ...c,
            _rawLocal: "delete", _rawRemote: "keep" });
        } else {
          applyEntityDecision(merged, c, prior.value, rop);
        }
        suppressedFieldPrefixes.push(`reel:${baseReel.id}:op:${opId}:`);
      }
    }

    // 对端新增工序（base 没有、本地也没有）→ 并入
    for (const rop of remoteReel.ops) {
      if (!baseOps.has(rop.id) && !localOps.has(rop.id)) {
        mergedReel.ops.push(clone(rop));
        autoApplied.push(`并入另一标签页在「${localReel.name}」新增的工序：${rop.kind}`);
      }
    }
  }

  /* ---------- 资源实体 ---------- */
  const baseResById = new Map(baseDoc.resources.map((r) => [r.id, r]));
  for (const br of baseDoc.resources) {
    const lr = localDoc.resources.find((r) => r.id === br.id);
    const rr = remoteDoc.resources.find((r) => r.id === br.id);
    const localChanged = lr && !jsonEqual(lr, br);
    if (lr && !rr) {
      if (!localChanged) {
        // 本页未改、对端删除 → 跟随删除
        merged.resources = merged.resources.filter((x) => x.id !== br.id);
        for (const reel of merged.reels) for (const op of reel.ops) {
          if (op.resourceId === br.id) op.resourceId = null;
        }
        autoApplied.push(`跟随另一标签页删除资源：${br.name}`);
        continue;
      }
      const c = {
        kind: "resource", sig: `entity:res:${br.id}`, entityId: br.id,
        label: `资源「${lr.name}」`,
        localAction: "keep", remoteAction: "delete",
        localText: "保留本页修改过的资源",
        remoteText: "跟随另一标签页删除（引用它的工序将变为未分配，需重新指派）",
        _keepSource: lr
      };
      const prior = priorFor(c.sig);
      if (prior) {
        applyEntityDecision(merged, c, prior.value, lr);
      } else {
        conflicts.push({ id: uid("cf"), entity: true, pick: null, ...c,
          _rawLocal: "keep", _rawRemote: "delete" });
      }
      suppressedFieldPrefixes.push(`res:${br.id}:`);
    }
  }
  const localResNames = new Set(merged.resources.map((r) => r.name));
  for (const rr of remoteDoc.resources) {
    if (!baseResById.has(rr.id) && !merged.resources.some((x) => x.id === rr.id) && !localResNames.has(rr.name)) {
      merged.resources.push(clone(rr));
      autoApplied.push(`并入另一标签页新增的资源：${rr.name}`);
      localResNames.add(rr.name);
    }
  }

  /* ---------- 版本 / 片段库 ---------- */
  const vIds = new Set(merged.versions.map((v) => v.id));
  for (const v of remoteDoc.versions) {
    if (!vIds.has(v.id)) {
      merged.versions.push(clone(v));
      vIds.add(v.id);
      autoApplied.push(`并入另一标签页锁定的版本 ${v.label}`);
    }
  }
  const segByCode = new Map((merged.segments || []).map((s) => [s.code, s]));
  for (const s of remoteDoc.segments || []) {
    if (!segByCode.has(s.code)) {
      merged.segments.push(clone(s));
      segByCode.set(s.code, s);
    }
  }

  /* ---------- 字段级三方比对 ---------- */
  const fb = flattenDoc(baseDoc);
  const fl = flattenDoc(localDoc);
  const fr = flattenDoc(remoteDoc);
  const allPaths = new Set([...fb.keys(), ...fl.keys(), ...fr.keys()]);
  const isSuppressed = (path) => suppressedFieldPrefixes.some((p) => path.startsWith(p));

  for (const path of allPaths) {
    if (isSuppressed(path)) continue;
    const b = fb.get(path), l = fl.get(path), r = fr.get(path);
    if (l === r) {
      if (l !== undefined) applyLeaf(merged, path, l);
      continue;
    }
    if (l === b && r !== b) {
      if (r !== undefined) {
        applyLeaf(merged, path, r);
        autoApplied.push(`field:${path}`);
      }
      continue;
    }
    if (r === b && l !== b) continue; // 仅本页改，merged 已持有
    // 双方都改且不同
    const prior = priorFor(path);
    if (prior && (prior.value === l || prior.value === r)) {
      if (prior.value !== undefined) applyLeaf(merged, path, prior.value);
      continue;
    }
    const info = parsePath(path, merged);
    conflicts.push({
      id: uid("cf"),
      entity: false,
      sig: conflictSig(path),
      path,
      label: info.label,
      localText: l === undefined ? "（本页删除）" : valueToText(info, l, localDoc),
      remoteText: r === undefined ? "（另一页删除）" : valueToText(info, r, remoteDoc),
      pick: null,
      _rawLocal: l,
      _rawRemote: r
    });
  }

  return { merged, conflicts, autoApplied };
}

/** 应用已裁决的实体决策（keep / delete）到合并结果 */
function applyEntityDecision(mergedDoc, conflict, value, keepSource = null) {
  if (conflict.kind === "reel") {
    if (value === "delete") {
      mergedDoc.reels = mergedDoc.reels.filter((r) => r.id !== conflict.entityId);
    } else if (keepSource && !mergedDoc.reels.some((r) => r.id === conflict.entityId)) {
      mergedDoc.reels.push(clone(keepSource));
    }
  } else if (conflict.kind === "op") {
    const reel = mergedDoc.reels.find((r) => r.id === conflict.reelId);
    if (!reel) return;
    if (value === "delete") {
      reel.ops = reel.ops.filter((o) => o.id !== conflict.entityId);
    } else if (keepSource && !reel.ops.some((o) => o.id === conflict.entityId)) {
      reel.ops.push(clone(keepSource));
    }
  } else if (conflict.kind === "resource") {
    if (value === "delete") {
      mergedDoc.resources = mergedDoc.resources.filter((x) => x.id !== conflict.entityId);
      for (const reel of mergedDoc.reels) for (const op of reel.ops) {
        if (op.resourceId === conflict.entityId) op.resourceId = null;
      }
    } else if (keepSource && !mergedDoc.resources.some((x) => x.id === conflict.entityId)) {
      mergedDoc.resources.push(clone(keepSource));
    }
  }
}

function conflictSig(path) {
  return path;
}

/** 按 ID 路径把叶子值写回 doc；目标实体缺失时跳过（删除场景） */
function applyLeaf(doc, path, valJson) {
  const value = JSON.parse(valJson);
  const info = parsePath(path, doc);
  if (info.type === "origin") {
    doc.origin = value;
  } else if (info.type === "res") {
    const res = (doc.resources || []).find((r) => r.id === info.resId);
    if (res) res[info.field] = value;
  } else if (info.type === "reel") {
    const reel = (doc.reels || []).find((r) => r.id === info.reelId);
    if (reel) reel[info.field] = value;
  } else if (info.type === "op") {
    const reel = (doc.reels || []).find((r) => r.id === info.reelId);
    const op = reel?.ops.find((o) => o.id === info.opId);
    if (op) op[info.field] = value;
  }
}

/** 收到 storage 事件（另一标签页写入） */
function onRemoteStorage(event) {
  if (event.key !== SCHED_KEY || !event.newValue) return;
  let remoteEnv;
  try {
    remoteEnv = JSON.parse(event.newValue);
  } catch {
    return;
  }
  if (!remoteEnv.doc) return;
  // 不能按修订号相等就跳过：两个标签页可能从同一基线各自写入相同修订号，
  // 此时仍必须三方合并（或报冲突），不能丢弃对端的优先级等改动。
  // 仅当文档与已解决记录都与本页完全一致（无新内容）时才跳过。
  if (remoteEnv.revision === env.revision
      && JSON.stringify(remoteEnv.doc) === JSON.stringify(env.doc)
      && JSON.stringify(remoteEnv.resolved || []) === JSON.stringify(env.resolved || [])) {
    return;
  }
  receiveRemote(remoteEnv);
}

function receiveRemote(remoteEnv, baseOverride = null) {
  const mergeBase = baseOverride || env.base;
  const { merged, conflicts, autoApplied } = threeWayMerge(mergeBase, env.doc, remoteEnv.doc, env.resolved || []);

  const niceAuto = autoApplied
    .filter((s) => !s.startsWith("field:"))
    .filter((v, i, arr) => arr.indexOf(v) === i);
  const fieldMerges = autoApplied.filter((s) => s.startsWith("field:")).length;
  if (fieldMerges) niceAuto.push(`自动并入 ${fieldMerges} 处另一标签页的字段修改（本页未改动的字段）。`);

  if (!conflicts.length) {
    const changed = JSON.stringify(env.doc) !== JSON.stringify(merged)
      || JSON.stringify(env.resolved || []) !== JSON.stringify(mergeResolved(env.resolved, remoteEnv.resolved));
    env.doc = merged;
    // 对端文档现在是共同祖先（其内容已包含合并结果）
    env.base = clone(remoteEnv.doc);
    env.resolved = mergeResolved(env.resolved, remoteEnv.resolved);
    if (changed) {
      // 只有本页确实并入了新内容才回写，否则会与另一个标签页无限回声
      env.revision = Math.max(env.revision, remoteEnv.revision) + 1;
      persistEnv();
    } else {
      env.revision = Math.max(env.revision, remoteEnv.revision);
    }
    renderAll();
    if (changed && niceAuto.length) toast(`已与另一标签页合并：${niceAuto[0]}`, "success", 4200);
  } else {
    pendingMerge = { merged, baseRemote: clone(remoteEnv.doc), remoteEnv, conflicts, autoApplied: niceAuto };
    pendingConflicts = conflicts;
    renderMergeBanner();
    toast("检测到与另一标签页的修改冲突，请在页面顶部裁决后保存。", "error", 5000);
  }
}

function mergeResolved(a, b) {
  const map = new Map();
  for (const r of [...(a || []), ...(b || [])]) {
    if (r && r.sig) map.set(r.sig, r); // 同字段后到的裁决覆盖
  }
  return [...map.values()].slice(-200);
}

let pendingMerge = null;

function resolveConflict(id, pick) {
  const c = pendingConflicts.find((x) => x.id === id);
  if (!c) return;
  c.pick = pick;
  if (c.entity) {
    // 实体冲突：选择本页/对端 → 对应 keep/delete 动作
    const action = pick === "local" ? c.localAction : c.remoteAction;
    applyEntityDecision(pendingMerge.merged, c, action, c._keepSource);
  } else {
    const raw = pick === "local" ? c._rawLocal : c._rawRemote;
    if (raw !== undefined) applyLeaf(pendingMerge.merged, c.path, raw);
  }
  renderMergeBanner();
}

function conflictResolutionValue(c) {
  if (c.entity) {
    // 记录最终动作（keep/delete），两个标签页视角一致
    return c.pick === "local" ? c.localAction : c.remoteAction;
  }
  return c.pick === "local" ? c._rawLocal : c._rawRemote;
}

function confirmMerge() {
  if (!pendingMerge) return;
  const unresolved = pendingConflicts.filter((c) => !c.pick);
  if (unresolved.length) {
    toast(`还有 ${unresolved.length} 处冲突未选择保留哪一边。`, "error");
    return;
  }
  const newResolved = pendingConflicts.map((c) => ({ sig: c.sig, value: conflictResolutionValue(c) }));
  env.doc = pendingMerge.merged;
  env.base = clone(pendingMerge.baseRemote);
  env.resolved = mergeResolved(mergeResolved(env.resolved, pendingMerge.remoteEnv.resolved), newResolved);
  env.revision = Math.max(env.revision, pendingMerge.remoteEnv.revision) + 1;
  persistEnv();
  pendingMerge = null;
  pendingConflicts = [];
  hideMergeBanner();
  renderAll();
  toast("冲突已按选择合并保存。", "success");
}

function cancelMerge() {
  pendingMerge = null;
  pendingConflicts = [];
  hideMergeBanner();
  toast("已放弃本次远端合并，本页修改保留未动；下次对端保存时会再次提示。", "success", 4200);
}

/* ============================================================
 * DOM 渲染
 * ==========================================================*/

const els = {};
function bindEls() {
  for (const id of [
    "originInput", "syncDeskBtn", "autoScheduleBtn", "undoBtn", "lockBtn", "exportBtn", "importBtn", "importFile",
    "resourceList", "resourceForm", "resNameInput", "resKindInput", "segmentPool", "segmentCount",
    "versionList", "liveDiff", "addReelBtn", "reelList", "gantt", "ganttLegend",
    "validationList", "validationSummary", "statReels", "statOps", "statErrors",
    "mergeBanner", "toast", "modal", "modalTitle", "modalBody", "modalActions"
  ]) {
    els[id] = document.getElementById(id);
  }
}

function renderAll() {
  renderValidation(); // 先刷新 validationCache，统计与甘特图都依赖它
  renderStats();
  renderResources();
  renderSegments();
  renderReels();
  renderGantt();
  renderVersions();
  renderLiveDiff();
  els.originInput.value = dtLocalValue(env.doc.origin);
  els.undoBtn.disabled = undoStack.length === 0;
  els.undoBtn.textContent = undoStack.length ? `↶ 撤销（${undoStack[0].label}）` : "↶ 撤销";
}

function renderStats() {
  els.statReels.textContent = env.doc.reels.length;
  els.statOps.textContent = allOps().length;
  els.statErrors.textContent = validationCache.errors.length;
}

function renderResources() {
  els.resourceList.innerHTML = env.doc.resources.map((r, i) => `
    <li class="resource-item">
      <span class="resource-swatch" style="background:${resourceColor(r.id)}"></span>
      <span class="res-name">${escapeHtml(r.name)}</span>
      <span class="res-kind">${escapeHtml(r.kind)}</span>
      <button type="button" data-del-res="${escapeHtml(r.id)}" title="删除资源">×</button>
    </li>
  `).join("") || `<p class="empty">还没有人员或设备。</p>`;
}

function resourceColor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const palette = ["#347d89", "#d49b35", "#b54d48", "#4d7656", "#6d6378", "#8a6d9f", "#3f7f8c"];
  return palette[hash % palette.length];
}

function renderSegments() {
  els.segmentCount.textContent = `${env.doc.segments.length} 条`;
  els.segmentPool.innerHTML = env.doc.segments.map((s) => {
    const dmg = s.damage && s.damage !== "完好";
    return `<div class="seg-chip">
      <b>${escapeHtml(s.code)}</b>
      <span>${Math.floor(s.duration / 60)}:${String(s.duration % 60).padStart(2, "0")}</span>
      <span>${escapeHtml(s.shift)}</span>
      ${dmg ? `<span class="seg-dmg">${escapeHtml(s.damage)}</span>` : ""}
      <span class="seg-meta">${escapeHtml(s.note || "")}</span>
    </div>`;
  }).join("") || `<p class="empty">片段库为空，点上方按钮从核对台同步。</p>`;
}

function renderReels() {
  const { errors, warnings } = validationCache;
  const opIssues = new Map(); // opId -> [msgs]
  for (const it of [...errors, ...warnings]) {
    if (it.opId) {
      if (!opIssues.has(it.opId)) opIssues.set(it.opId, []);
      opIssues.get(it.opId).push(it);
    }
  }

  els.reelList.innerHTML = env.doc.reels.map((reel) => {
    const reelLevelErrors = errors.filter((e) => e.reelId === reel.id && !e.opId);
    const optsRes = env.doc.resources.map((r) => `<option value="${r.id}">${escapeHtml(r.name)}（${r.kind}）</option>`).join("");
    const rows = reel.ops.map((op, idx) => {
      const issues = opIssues.get(op.id) || [];
      const hasErr = issues.some((i) => i.level === "error");
      const deps = reel.ops.filter((o) => o.id !== op.id).map((o) =>
        `<option value="${o.id}" ${op.dependsOn.includes(o.id) ? "selected" : ""}>${escapeHtml(o.kind)} #${reel.ops.indexOf(o) + 1}</option>`
      ).join("");
      const end = opEnd(op);
      const status = issues.length
        ? issues.map((i) => `<span class="op-status ${i.level === "error" ? issueClass(i.code) : "none"}">${escapeHtml(shortIssue(i))}</span>`).join("<br>")
        : (op.start ? `<span class="op-status ok">已排 ${escapeHtml(fmtClock(op.start))}</span>` : `<span class="op-status none">未排期</span>`);
      return `
      <tr class="${hasErr ? "row-error" : ""}" data-op-row="${escapeHtml(op.id)}">
        <td class="op-kind-cell ${KIND_CLASS[op.kind] || ""}">#${idx + 1} ${escapeHtml(op.kind)}</td>
        <td><input type="number" min="5" step="5" value="${op.duration}" data-op-field="duration" data-op="${escapeHtml(op.id)}" style="width:76px" /></td>
        <td>
          <select data-op-field="resourceId" data-op="${escapeHtml(op.id)}">
            <option value="">未分配</option>
            ${env.doc.resources.map((r) => `<option value="${r.id}" ${r.id === op.resourceId ? "selected" : ""}>${escapeHtml(r.name)}</option>`).join("")}
          </select>
        </td>
        <td><input type="datetime-local" step="300" value="${dtLocalValue(op.start)}" data-op-field="start" data-op="${escapeHtml(op.id)}" /></td>
        <td>
          <select class="deps-sel" multiple data-op-field="dependsOn" data-op="${escapeHtml(op.id)}" title="按住 Ctrl 多选前序">${deps}</select>
        </td>
        <td>${status}<div class="op-status none" style="font-weight:400">${end ? `止于 ${escapeHtml(fmtClock(end))}` : ""}</div></td>
        <td class="op-row-del"><button type="button" class="small danger" data-del-op="${escapeHtml(op.id)}">删</button></td>
      </tr>`;
    }).join("");

    const addRow = `
      <tr class="add-op-row"><td colspan="7">
        <form class="add-op-form" data-add-op="${escapeHtml(reel.id)}">
          <select name="kind">${OP_KINDS.map((k) => `<option>${k}</option>`).join("")}</select>
          <select name="resourceId"><option value="">未分配资源</option>${optsRes}</select>
          <input name="duration" type="number" min="5" step="5" value="30" title="时长（分）" style="width:80px" />
          <button type="submit" class="small">＋ 工序</button>
        </form>
      </td></tr>`;

    return `
    <article class="reel-card p${reel.priority}" data-reel="${escapeHtml(reel.id)}">
      <div class="reel-head">
        <label class="field-name">卷名
          <input class="reel-title-input" value="${escapeHtml(reel.name)}" data-reel-field="name" data-reel="${escapeHtml(reel.id)}" />
        </label>
        <label class="field-narrow">优先级
          <select data-reel-field="priority" data-reel="${escapeHtml(reel.id)}">
            ${PRIORITIES.map((p) => `<option value="${p.value}" ${Number(reel.priority) === p.value ? "selected" : ""}>${p.label}</option>`).join("")}
          </select>
        </label>
        <label class="field">截止时间
          <input type="datetime-local" step="300" class="${reelLevelErrors.some((e) => e.code === "BAD_DEADLINE") ? "reel-deadline-late" : ""}" value="${dtLocalValue(reel.deadline)}" data-reel-field="deadline" data-reel="${escapeHtml(reel.id)}" />
        </label>
        <span class="priority-badge p${reel.priority}">${PRIORITIES.find((p) => p.value === Number(reel.priority))?.label || ""}优先</span>
        <span class="op-status none" style="font-weight:600">关联片段：${escapeHtml((reel.segmentCodes || []).join("、") || "无")}</span>
        <button type="button" class="small danger" data-del-reel="${escapeHtml(reel.id)}">删除整卷</button>
      </div>
      <table class="ops-table">
        <thead><tr>
          <th>工序</th><th>时长(分)</th><th>人员/设备</th><th>开始时间</th><th>前序依赖</th><th>状态</th><th></th>
        </tr></thead>
        <tbody>${rows}${addRow}</tbody>
      </table>
    </article>`;
  }).join("") || `<p class="empty">还没有胶片卷，点右上角「新增胶片卷」。</p>`;
}

function issueClass(code) {
  if (code === "OVERLAP") return "busy";
  if (code === "OVERDUE") return "late";
  if (code === "CYCLE" || code === "MISSING_DEP") return "cycle";
  return "busy";
}

function shortIssue(issue) {
  switch (issue.code) {
    case "OVERLAP": return "⚠ 资源重叠";
    case "OVERDUE": return "⚠ 超出截止";
    case "CYCLE": return "⚠ 循环依赖";
    case "MISSING_DEP": return "⚠ 依赖缺失";
    case "PRECEDENCE": return "⚠ 早于前序";
    case "NO_RESOURCE": return "未分配资源";
    case "UNSCHEDULED": return "未排时间";
    case "BAD_TIME": return "时间非法";
    case "BAD_DURATION": return "时长非法";
    case "BEFORE_ORIGIN": return "早于开门（提示）";
    default: return issue.message;
  }
}

function renderGantt() {
  const { errors } = validationCache;
  const overlapPairs = new Set();
  for (const e of errors) {
    if (e.code === "OVERLAP") overlapPairs.add(`${e.opId}|${e.otherOpId}`);
  }

  const originMs = new Date(env.doc.origin).getTime();
  // 时间范围：origin 到最晚结束/截止之后 30 分
  let maxMs = originMs + 4 * 3600000;
  for (const op of allOps()) {
    if (op.start != null) maxMs = Math.max(maxMs, new Date(op.start).getTime() + op.duration * 60000);
  }
  for (const reel of env.doc.reels) {
    if (reel.deadline) maxMs = Math.max(maxMs, new Date(reel.deadline).getTime());
  }
  maxMs += 30 * 60000;
  const totalMin = Math.max(120, Math.ceil((maxMs - originMs) / 60000));
  const widthPx = totalMin * PX_PER_MIN + 130;
  els.gantt.style.width = `${widthPx}px`;

  // 网格：每 30 分细线，每小时粗线+标签
  let gridHtml = "";
  for (let m = 0; m <= totalMin; m += 30) {
    const major = m % 60 === 0;
    gridHtml += `<div class="gantt-grid-line ${major ? "major" : ""}" style="left:${130 + m * PX_PER_MIN}px"></div>`;
    if (major) {
      gridHtml += `<div class="gantt-tick-label" style="left:${130 + m * PX_PER_MIN + 2}px">${escapeHtml(fmtClock(new Date(originMs + m * 60000)))}</div>`;
    }
  }

  // 截止虚线（画在每个资源行不现实，统一在最上层全图行？这里画在各行内）
  const rows = env.doc.resources.map((res) => {
    const opsHere = allOps().filter((o) => o.resourceId === res.id);
    let bars = "";
    for (const op of opsHere) {
      const reel = findReel(op.reelId);
      const hit = [...overlapPairs].some((pair) => {
        const [a, b] = pair.split("|");
        return a === op.id || b === op.id;
      });
      if (op.start == null) {
        bars += `<div class="gantt-bar unscheduled" style="left:8px;width:120px" title="${escapeHtml(reel.name)} · ${op.kind}：未排期">${escapeHtml(reel.name)}·${escapeHtml(op.kind)} 未排</div>`;
        continue;
      }
      const st = new Date(op.start).getTime();
      const left = ((st - originMs) / 60000) * PX_PER_MIN;
      const w = Math.max(10, op.duration * PX_PER_MIN);
      const end = new Date(st + op.duration * 60000);
      bars += `<div class="gantt-bar kind-${op.kind} ${hit ? "overlap-hit" : ""}" style="left:${left}px;width:${w}px"
        title="${escapeHtml(reel.name)} · ${escapeHtml(op.kind)}&#10;${escapeHtml(fmtClock(op.start))}–${escapeHtml(fmtClock(end))}&#10;资源：${escapeHtml(res.name)}">
        ${escapeHtml(reel.name)}·${escapeHtml(op.kind)}</div>`;
    }
    // 截止虚线：画所有卷的截止线（在每一行可见）
    let lines = "";
    for (const reel of env.doc.reels) {
      if (!reel.deadline) continue;
      const dl = new Date(reel.deadline).getTime();
      if (dl < originMs) continue;
      const x = ((dl - originMs) / 60000) * PX_PER_MIN;
      lines += `<div class="deadline-line" style="left:${x}px"><div class="deadline-label" style="left:0">止 ${escapeHtml(reel.name)}</div></div>`;
    }
    return `
      <div class="gantt-row">
        <div class="gantt-label"><span class="resource-swatch" style="background:${resourceColor(res.id)};width:10px;height:16px"></span>${escapeHtml(res.name)}</div>
        <div class="gantt-track">${lines}${bars}</div>
      </div>`;
  }).join("");

  // 未分配资源行
  const unassigned = allOps().filter((o) => !o.resourceId);
  const unRow = unassigned.length ? `
    <div class="gantt-row">
      <div class="gantt-label" style="color:var(--red)">未分配</div>
      <div class="gantt-track">
        ${unassigned.map((op, i) => {
          const reel = findReel(op.reelId);
          return `<div class="gantt-bar unscheduled" style="left:${8 + i * 130}px;width:120px" title="未分配资源">${escapeHtml(reel.name)}·${escapeHtml(op.kind)}</div>`;
        }).join("")}
      </div>
    </div>` : "";

  els.gantt.innerHTML = gridHtml + rows + unRow;
  els.ganttLegend.innerHTML =
    OP_KINDS.map((k) => `<span><i style="background:${KIND_COLOR[k]}"></i>${k}</span>`).join("") +
    `<span><i style="background:#b0ab99"></i>未排/未分配</span>` +
    `<span><i style="border:2px dashed var(--red);background:transparent;width:16px"></i>卷截止时间</span>`;
}

let validationCache = { errors: [], warnings: [] };

function renderValidation() {
  validationCache = validate(env.doc);
  const { errors, warnings } = validationCache;
  const items = [];
  if (!errors.length && !warnings.length) {
    items.push(`<li class="v-item ok"><span class="v-icon">✓</span><span>所有工序均已排期，无资源冲突、无超期、依赖完整，可以锁定版本。</span></li>`);
  }
  for (const e of errors) {
    items.push(`<li class="v-item error" data-jump="${e.opId || e.reelId || ""}"><span class="v-icon">✕</span><span>${escapeHtml(e.message)}</span></li>`);
  }
  for (const w of warnings) {
    items.push(`<li class="v-item warn"><span class="v-icon">!</span><span>${escapeHtml(w.message)}</span></li>`);
  }
  els.validationList.innerHTML = items.join("");
  els.validationSummary.textContent = errors.length
    ? `${errors.length} 个阻断问题${warnings.length ? `、${warnings.length} 条提示` : ""}，锁定与提交已被阻止`
    : (warnings.length ? `${warnings.length} 条提示，不阻止锁定` : "校验通过");
  els.validationSummary.style.color = errors.length ? "var(--red)" : warnings.length ? "#8a621a" : "var(--green)";
  els.validationSummary.style.fontWeight = "800";
}

function renderVersions() {
  els.versionList.innerHTML = env.doc.versions.map((v) => `
    <div class="version-card">
      <div class="vc-top"><strong>${escapeHtml(v.label)}</strong><time>${escapeHtml(fmtClock(v.lockedAt))}</time></div>
      <p class="vc-note">${escapeHtml(v.note || "（无备注）")} · ${v.reels.length} 卷</p>
      <div class="vc-actions">
        <button class="small" data-ver-diff="${escapeHtml(v.id)}">查看差异</button>
        <button class="small" data-ver-export="${escapeHtml(v.id)}">导出此版本</button>
      </div>
    </div>`).join("") || `<p class="empty">尚无锁定版本。校验通过后可锁定快照。</p>`;
}

function renderLiveDiff() {
  const last = env.doc.versions[env.doc.versions.length - 1];
  if (!last) {
    els.liveDiff.innerHTML = "";
    return;
  }
  const lines = diffDocs(
    { origin: last.origin, resources: last.resources, reels: last.reels, versions: [] },
    { ...env.doc, versions: [] }
  );
  els.liveDiff.innerHTML = `
    <h3>相对 ${escapeHtml(last.label)} 的未发布改动（${lines.length} 处）</h3>
    ${lines.slice(0, 30).map((l) => `<div class="diff-line ${l.kind}"><span class="diff-char">${l.kind === "add" ? "+" : l.kind === "del" ? "−" : "～"}</span><span>${escapeHtml(l.text)}</span></div>`).join("") || `<p class="empty">自 ${escapeHtml(last.label)} 以来没有改动。</p>`}
    ${lines.length > 30 ? `<p class="empty">……另有 ${lines.length - 30} 处，点版本卡「查看差异」看全部。</p>` : ""}`;
}

/* ============================================================
 * 合并横幅
 * ==========================================================*/

function renderMergeBanner() {
  if (!pendingMerge) {
    hideMergeBanner();
    return;
  }
  els.mergeBanner.hidden = false;
  const entityN = pendingConflicts.filter((c) => c.entity).length;
  const fieldN = pendingConflicts.length - entityN;
  const kinds = [];
  if (fieldN) kinds.push(`${fieldN} 处字段冲突`);
  if (entityN) kinds.push(`${entityN} 处删除/保留冲突`);
  els.mergeBanner.innerHTML = `
    <h3>⚠ 双标签页并发修改：${kinds.join("、")}，需要裁决（不会静默覆盖任何一边）</h3>
    <p class="empty" style="color:var(--ink);font-size:13px;margin-bottom:10px">
      双方修改了相同字段，或一方删除了另一方仍在修改的卷/工序/资源。请逐条选择保留「本页」还是「另一页」的结果；非冲突改动（新增卷、资源、锁版）已自动并入。
    </p>
    ${pendingConflicts.map((c) => `
      <div class="conflict-row">
        <div><strong>${escapeHtml(c.label)}${c.entity ? ' <span class="ent-tag">实体删除</span>' : ""}</strong></div>
        <div class="cf-choices">
          <button type="button" class="conflict-val ${c.pick === "local" ? "chosen" : ""}" data-pick="${escapeHtml(c.id)}|local">
            <b class="cv-tag-local">本页修改</b><span>${escapeHtml(c.localText)}</span>
          </button>
          <button type="button" class="conflict-val ${c.pick === "remote" ? "chosen" : ""}" data-pick="${escapeHtml(c.id)}|remote">
            <b class="cv-tag-remote">另一标签页</b><span>${escapeHtml(c.remoteText)}</span>
          </button>
        </div>
      </div>`).join("")}
    <div class="modal-actions" style="margin-top:4px">
      <button data-merge-cancel>放弃合并（保留本页）</button>
      <button class="primary" data-merge-confirm>按选择合并保存</button>
    </div>`;
  els.mergeBanner.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideMergeBanner() {
  els.mergeBanner.hidden = true;
  els.mergeBanner.innerHTML = "";
}

/* ============================================================
 * 弹窗 / 提示
 * ==========================================================*/

function toast(message, kind = "", ms = 3200) {
  els.toast.textContent = message;
  els.toast.className = `toast ${kind}`;
  els.toast.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { els.toast.hidden = true; }, ms);
}

function openModal(title, bodyHtml, actions) {
  els.modalTitle.textContent = title;
  els.modalBody.innerHTML = bodyHtml;
  els.modalActions.innerHTML = actions.map((a, i) =>
    `<button data-modal-act="${i}" class="${a.primary ? "primary" : ""} ${a.danger ? "danger" : ""}">${escapeHtml(a.label)}</button>`
  ).join("");
  els.modal._handlers = actions.map((a) => a.onClick || (() => {}));
  if (typeof els.modal.showModal === "function") els.modal.showModal();
  else els.modal.setAttribute("open", "");
}

function closeModal() {
  if (typeof els.modal.close === "function") els.modal.close();
  else els.modal.removeAttribute("open");
}

/* ============================================================
 * 业务操作
 * ==========================================================*/

function doAutoSchedule() {
  const before = clone(env.doc);
  const next = autoSchedule(env.doc);
  env.doc = next;
  env.revision += 1;
  persistEnv();
  undoStack = [{ label: "自动排期", before, after: clone(env.doc) }];
  renderAll();
  const { errors } = validate(env.doc);
  if (errors.length) toast(`自动排期完成，但仍有 ${errors.length} 个阻断问题（多为跨卷资源或循环依赖）。`, "error", 4600);
  else toast("自动排期完成：按优先级、依赖顺序与资源空档排好。", "success");
}

function undoLastBatch() {
  const last = undoStack[0];
  if (!last) return;
  env.doc = clone(last.before);
  env.revision += 1;
  persistEnv();
  undoStack = [];
  renderAll();
  toast(`已撤销「${last.label}」。`, "success");
}

function doLock() {
  const { errors } = validate(env.doc);
  if (errors.length) {
    openModal(
      "无法锁定版本：存在阻断问题",
      `<p class="empty" style="color:var(--red);font-size:13px">以下问题必须先解决（锁定与提交已被阻止）：</p>
       <div class="import-report">${errors.map((e) => `<div class="ir-bad">✕ ${escapeHtml(e.message)}</div>`).join("")}</div>`,
      [{ label: "我知道了，去修改", primary: true, onClick: closeModal }]
    );
    return;
  }
  openModal(
    "校验通过，锁定版本",
    `<label style="display:grid;gap:6px;font-size:13px;color:var(--ink)">版本备注（可选）
      <textarea id="lockNote" rows="3" placeholder="例：试映前第一轮修复完成"></textarea></label>
     <p class="empty" style="margin-top:10px">锁定后快照不可修改；之后的改动会在左栏显示与该版本的差异。</p>`,
    [
      { label: "取消", onClick: closeModal },
      {
        label: "确认锁定", primary: true,
        onClick: () => {
          const note = document.getElementById("lockNote").value.trim();
          const res = lockVersion(note);
          closeModal();
          if (res.ok) toast(`已锁定 ${res.label}（不可变快照）。`, "success");
        }
      }
    ]
  );
}

function showVersionDiff(versionId) {
  const v = env.doc.versions.find((x) => x.id === versionId);
  if (!v) return;
  const lines = diffDocs({ origin: v.origin, resources: v.resources, reels: v.reels, versions: [] }, { ...env.doc, versions: [] });
  openModal(
    `${v.label} 与当前草稿的差异`,
    `<table class="diff-table">
       <thead><tr><th style="width:40px"></th><th>差异（锁定版 → 当前草稿）</th></tr></thead>
       <tbody>${lines.map((l) => `<tr><td class="${l.kind === "add" ? "new" : l.kind === "del" ? "old" : ""}"><b>${l.kind === "add" ? "+" : l.kind === "del" ? "−" : "～"}</b></td><td>${escapeHtml(l.text)}</td></tr>`).join("") || `<tr><td></td><td>没有差异。</td></tr>`}</tbody>
     </table>`,
    [{ label: "关闭", primary: true, onClick: closeModal }]
  );
}

function exportOneVersion(versionId) {
  const v = env.doc.versions.find((x) => x.id === versionId);
  if (!v) return;
  const payload = {
    format: "film-restore-schedule", schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    origin: v.origin, resources: v.resources, reels: v.reels,
    lockedVersions: [v]
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `film-schedule-${safeFilePart(v.label)}.json`;
  link.click();
  URL.revokeObjectURL(link.href);
  toast(`已导出锁定版本 ${v.label}。`, "success");
}

function syncFromDesk() {
  let deskRaw;
  try {
    deskRaw = JSON.parse(localStorage.getItem(DESK_KEY) || "null");
  } catch {
    deskRaw = null;
  }
  if (!deskRaw || !Array.isArray(deskRaw.segments)) {
    toast("没有读到核对台数据（键 " + DESK_KEY + "）。请先在核对台录入片段。", "error", 4600);
    return;
  }
  const incoming = deskRaw.segments.map((s) => ({
    id: s.id || uid("seg"),
    code: String(s.code || "未编号"),
    duration: Number(s.duration) || 0,
    shift: s.shift || "正常",
    damage: s.damage || "完好",
    note: s.note || ""
  }));
  const byCode = new Map(env.doc.segments.map((s) => [s.code, s]));
  let added = 0, updated = 0;
  for (const inc of incoming) {
    if (byCode.has(inc.code)) {
      Object.assign(byCode.get(inc.code), inc, { id: byCode.get(inc.code).id });
      updated++;
    } else {
      env.doc.segments.push(inc);
      byCode.set(inc.code, inc);
      added++;
    }
  }
  // 若当前一卷都没有，按编号前缀自动建卷并把片段挂上去
  let autoReels = 0;
  if (env.doc.reels.length === 0 && incoming.length) {
    const groups = new Map();
    for (const s of incoming) {
      const prefix = (s.code.match(/^[^\d-]+/) || ["X"])[0];
      if (!groups.has(prefix)) groups.set(prefix, []);
      groups.get(prefix).push(s.code);
    }
    for (const [prefix, codes] of groups) {
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + 2);
      deadline.setHours(18, 0, 0, 0);
      const reelId = uid("reel");
      env.doc.reels.push({
        id: reelId, name: `${prefix}卷`, priority: 2, deadline: deadline.toISOString(),
        segmentCodes: codes, ops: []
      });
      autoReels++;
    }
  }
  commitDoc(null);
  toast(`已同步核对台片段：新增 ${added}、更新 ${updated}${autoReels ? `，并自动建立 ${autoReels} 个卷` : ""}。`, "success", 4200);
}

/* ============================================================
 * 事件绑定
 * ==========================================================*/

function wireEvents() {
  els.originInput.addEventListener("change", () => {
    const v = els.originInput.value;
    if (!v) return;
    commitDoc(() => { env.doc.origin = new Date(v).toISOString(); });
  });

  els.syncDeskBtn.addEventListener("click", syncFromDesk);
  els.autoScheduleBtn.addEventListener("click", doAutoSchedule);
  els.undoBtn.addEventListener("click", undoLastBatch);
  els.lockBtn.addEventListener("click", doLock);
  els.exportBtn.addEventListener("click", exportSchedule);
  els.importBtn.addEventListener("click", () => els.importFile.click());

  els.importFile.addEventListener("change", async (event) => {
    const file = event.target.files[0];
    event.target.value = "";
    if (!file) return;
    const text = await file.text();
    const result = validateImport(text);
    const body = `
      ${result.errors.length ? `<div class="import-report">${result.errors.map((e) => `<div class="ir-bad">✕ ${escapeHtml(e.message)}</div>`).join("")}</div>` : `<p class="ir-ok">✓ 未发现重复 ID、缺失依赖或非法时间。</p>`}
      ${result.warnings.length ? `<div class="import-report">${result.warnings.map((w) => `<div>! ${escapeHtml(w.message)}</div>`).join("")}</div>` : ""}
      ${result.valid ? `<p class="empty" style="font-size:13px">将导入 ${result.normalized.resources.length} 个资源、${result.normalized.reels.length} 个卷（${result.normalized.reels.reduce((n, r) => n + r.ops.length, 0)} 道工序）、${result.normalized.versions.length} 个锁定版本。该批导入可撤销。</p>` : `<p class="empty" style="color:var(--red);font-size:13px">存在阻断问题，导入已被阻止；请在来源系统修正后重新导出。</p>`}`;
    const actions = [{ label: "关闭", onClick: closeModal }];
    if (result.valid) {
      actions.push({
        label: "确认导入（可撤销）", primary: true,
        onClick: () => {
          applyImport(result.normalized);
          closeModal();
          toast("导入完成，整批操作可点「撤销」回退。", "success");
        }
      });
    }
    openModal("导入校验报告", body, actions);
  });

  // 资源
  els.resourceForm.addEventListener("submit", (e) => {
    e.preventDefault();
    const name = els.resNameInput.value.trim();
    if (!name) return;
    commitDoc(() => {
      env.doc.resources.push({ id: uid("res"), name, kind: els.resKindInput.value });
    });
    els.resourceForm.reset();
  });
  els.resourceList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-del-res]");
    if (!btn) return;
    const id = btn.dataset.delRes;
    const used = allOps().filter((o) => o.resourceId === id).length;
    if (used && !confirm(`资源「${resName(id)}」正被 ${used} 道工序使用，删除后这些工序将变为未分配。确认删除？`)) return;
    commitDoc(() => {
      env.doc.resources = env.doc.resources.filter((r) => r.id !== id);
      for (const reel of env.doc.reels) for (const op of reel.ops) if (op.resourceId === id) op.resourceId = null;
    });
  });

  // 卷与工序
  els.addReelBtn.addEventListener("click", () => {
    const deadline = new Date();
    deadline.setDate(deadline.getDate() + 1);
    deadline.setHours(18, 0, 0, 0);
    commitDoc(() => {
      env.doc.reels.push({
        id: uid("reel"), name: `新胶片卷 ${env.doc.reels.length + 1}`,
        priority: 2, deadline: deadline.toISOString(), segmentCodes: [], ops: []
      });
    });
  });

  els.reelList.addEventListener("click", (e) => {
    const delReel = e.target.closest("[data-del-reel]");
    const delOp = e.target.closest("[data-del-op]");
    if (delReel) {
      const reel = findReel(delReel.dataset.delReel);
      if (!confirm(`删除整卷「${reel.name}」及其 ${reel.ops.length} 道工序？`)) return;
      commitDoc(() => {
        const id = delReel.dataset.delReel;
        env.doc.reels = env.doc.reels.filter((r) => r.id !== id);
        // 清掉对它内部工序的悬空依赖（同卷才可能）
        const gone = new Set(reel.ops.map((o) => o.id));
        for (const r of env.doc.reels) for (const op of r.ops) op.dependsOn = op.dependsOn.filter((d) => !gone.has(d));
      });
    }
    if (delOp) {
      const opId = delOp.dataset.delOp;
      commitDoc(() => {
        for (const reel of env.doc.reels) {
          reel.ops = reel.ops.filter((o) => o.id !== opId);
          for (const op of reel.ops) op.dependsOn = op.dependsOn.filter((d) => d !== opId);
        }
      });
    }
  });

  els.reelList.addEventListener("change", (e) => {
    const reelField = e.target.closest("[data-reel-field]");
    const opField = e.target.closest("[data-op-field]");
    if (reelField) {
      const reel = findReel(reelField.dataset.reel);
      const field = reelField.dataset.reelField;
      let value = reelField.value;
      if (field === "priority") value = Number(value);
      if (field === "deadline") {
        if (!value) return;
        value = new Date(value).toISOString();
      }
      commitDoc(() => { reel[field] = value; });
    }
    if (opField) {
      const found = findOp(opField.dataset.op);
      if (!found) return;
      const { op } = found;
      const field = opField.dataset.opField;
      let value;
      if (field === "duration") value = Math.max(0, Number(opField.value) || 0);
      else if (field === "resourceId") value = opField.value || null;
      else if (field === "start") value = opField.value ? new Date(opField.value).toISOString() : null;
      else if (field === "dependsOn") {
        value = [...opField.selectedOptions].map((o) => o.value);
      } else value = opField.value;
      commitDoc(() => { op[field] = value; });
    }
  });

  // reel name input 实时编辑（input 事件）
  els.reelList.addEventListener("submit", (e) => {
    const form = e.target.closest("[data-add-op]");
    if (!form) return;
    e.preventDefault();
    const reelId = form.dataset.addOp;
    const reel = findReel(reelId);
    const fd = new FormData(form);
    commitDoc(() => {
      reel.ops.push({
        id: uid("op"), reelId,
        kind: fd.get("kind"),
        duration: Number(fd.get("duration")) || DEFAULT_DUR[fd.get("kind")] || 30,
        resourceId: fd.get("resourceId") || null,
        dependsOn: [],
        start: null,
        note: ""
      });
    });
  });

  // 版本卡
  els.versionList.addEventListener("click", (e) => {
    const diff = e.target.closest("[data-ver-diff]");
    const exp = e.target.closest("[data-ver-export]");
    if (diff) showVersionDiff(diff.dataset.verDiff);
    if (exp) exportOneVersion(exp.dataset.verExport);
  });

  // 校验列表点击定位
  els.validationList.addEventListener("click", (e) => {
    const li = e.target.closest("[data-jump]");
    if (!li || !li.dataset.jump) return;
    const row = document.querySelector(`[data-op-row="${li.dataset.jump}"]`) || document.querySelector(`[data-reel="${li.dataset.jump}"]`);
    if (row) {
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.style.outline = "2px solid var(--red)";
      setTimeout(() => (row.style.outline = ""), 1600);
    }
  });

  // 合并横幅
  els.mergeBanner.addEventListener("click", (e) => {
    const pick = e.target.closest("[data-pick]");
    if (pick) {
      const [id, side] = pick.dataset.pick.split("|");
      resolveConflict(id, side);
    }
    if (e.target.closest("[data-merge-confirm]")) confirmMerge();
    if (e.target.closest("[data-merge-cancel]")) cancelMerge();
  });

  els.modalActions.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-modal-act]");
    if (!btn) return;
    const fn = els.modal._handlers?.[Number(btn.dataset.modalAct)];
    if (fn) fn();
  });

  window.addEventListener("storage", onRemoteStorage);
}

/* ============================================================
 * 启动
 * ==========================================================*/

function init() {
  bindEls();
  wireEvents();
  renderAll();
  // 暴露给自动化测试
  window.__scheduleApp = {
    getState: () => clone(env.doc),
    getEnv: () => clone(env),
    validate: () => validate(env.doc),
    autoSchedule: () => { doAutoSchedule(); },
    lock: (note) => lockVersion(note || ""),
    undo: undoLastBatch,
    exportData: buildExportDoc,
    validateImport,
    applyImport,
    threeWayMerge,
    diffDocs,
    /** 测试用：以「本页编辑」语义修改文档（不触碰合并基线） */
    localEdit: (mutator, label) => commitDoc(mutator, { batchLabel: label }),
    /** 测试用：模拟另一个标签页写入信封（走与 storage 事件完全相同的合并路径） */
    simulateRemoteWrite: (remoteDoc, remoteRevision, baseOverride) => {
      const remoteEnv = {
        doc: remoteDoc,
        base: clone(remoteDoc),
        revision: remoteRevision || env.revision + 100,
        resolved: []
      };
      receiveRemote(remoteEnv, baseOverride || null);
      return { conflicts: clone(pendingConflicts) };
    },
    resolveConflict,
    confirmMerge,
    cancelMerge,
    getPendingConflicts: () => clone(pendingConflicts),
    resetAll: () => {
      const doc = defaultDoc();
      env = { doc, base: clone(doc), revision: 1, resolved: [] };
      undoStack = [];
      pendingMerge = null;
      pendingConflicts = [];
      hideMergeBanner();
      persistEnv();
      renderAll();
    }
  };
}

init();
