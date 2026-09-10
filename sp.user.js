// ==UserScript==
// @name         虾皮跑任务
// @namespace    https://viayoo.com/
// @version      2.1.0
// @description  虾皮任务：领取→抓 get_rw→上传，含时段配额
// @author       You
// @run-at       document-start
// @match        https://shopee.tw/*
// @match        https://*.shopee.tw/*
// @grant        GM_xmlhttpRequest
// @connect      raw.githubusercontent.com
// @downloadURL  https://cdn.jsdelivr.net/gh/ChunKitGitHub/new-codeg-releases@main/sp.user.js
// @updateURL    https://cdn.jsdelivr.net/gh/ChunKitGitHub/new-codeg-releases@main/sp.user.js
// ==/UserScript==

// ============================================================================
// shopee-via-runner.js —— 虾皮跑任务一体机（仅 shopee，不含其它平台）
//
// 一个文件搞定：填令牌 → 配置 → 领任务 → 抓 get_rw → 上传 → 统计。
// 自带界面，手机上不需要控制台。
//
// Via 安装：脚本头已写好 @match / @grant，直接粘贴全文即可。
//   注入时机必须是 document-start（头里的 @run-at 已声明）。
//
// 跨域：allplat.top 的接口一个 CORS 头都不回（实测 claimTask / completeTask /
//   failTask / getUserInfo 全无 Access-Control-Allow-Origin），直接 fetch 必被
//   浏览器拦掉报 "Load failed"。所以用 @grant GM_xmlhttpRequest —— 它在扩展层
//   发请求，天然不受 CORS 限制。拿不到 GM 时会退回 postMessage 中继桥
//   （那种情况才需要给 allplat.top 也加一条 @match）。
//
// 免登录：不做账号密码登录（服务端可能开着图形验证码，手机上不好处理）。
//   在后台登录一次，把 x-token 复制到界面①里即可；token 会自动续签。
//
// 抓数据三条路线（界面③可勾选，按风控暴露面从小到大）：
//   C 软导航（默认）—— 在当前标签页软跳到商品页，让【页面自己】发 get_rw，
//     我们只截响应。Referer / 前端自有头 / 风控签名全部真实，且不冷加载。
//     抓完软跳回首页。整个会话只有你第一次打开首页那一次冷加载。
//   B 后台标签页 —— Referer 真实，但 window.open 是冷加载，会弹「系统不稳定」。
//   A 直连 fetch get_rw —— 不冷加载，但 Referer 是首页、缺前端自有头，
//     **实测被风控拦**（error=90309999 + 跳 /verify/traffic/error）。默认关闭。
//
// 为什么 A 会被拦：服务端看到「这个会话从没打开过该商品页，却精准要了它的详情」。
//   风控签名是页面 JS 现场算的，伪造不了 —— 所以正解不是伪造上下文，
//   而是真的产生上下文（走 C）。这也正是「手动点商品正常」所证明的那条路。
//
// 时段配额：按「时段剩余时间 ÷ 时段剩余单数」动态算间隔，把单量均匀铺开。
//
// 通知：验证码每 10 秒推一次（最多 10 次）；风控推两次；其它情况只推一次。
// ============================================================================
(function () {
  'use strict';

  const 版本 = '2.1.0';

  // ────────────────────────────────────────────── 常量
  const 接口基址 = 'https://allplat.top/api';
  const 平台 = 'shopee';
  // GitHub Raw 用于检查（版本立刻可见）；jsDelivr 用于安装（响应是
  // application/javascript，Via 才会弹出覆盖安装确认，而不是只下载文本）。
  // 安装时固定到 v<版本号> Git tag，避免 main 分支 CDN 缓存装到旧版本。
  // 两者都只承载公开脚本，更新请求绝不携带 allplat token、账号或任务数据。
  const 更新检查地址 =
    'https://raw.githubusercontent.com/ChunKitGitHub/new-codeg-releases/main/sp.user.js';
  const 更新安装地址 =
    'https://cdn.jsdelivr.net/gh/ChunKitGitHub/new-codeg-releases@main/sp.user.js';
  const 更新检查间隔毫秒 = 12 * 60 * 60 * 1000;
  const 更新请求超时毫秒 = 15000;

  // AES-256-CBC，key/iv 与服务端硬编码一致（接口文档 §2）
  const 密钥文本 = '6y&omes3mXeJt3MYIVZN4T-q52Dio$p*';   // 32 字节
  const 向量文本 = 'J6$b#r1RGeCbJ*nN';                   // 16 字节

  // get_rw 地址模板。{item} {shop} 会被替换；界面里可改
  const 默认接口模板 =
    'https://shopee.tw/api/v4/pdp/get_rw?display_model_id=0&item_id={item}' +
    '&model_selection_logic=3&shop_id={shop}&tz_offset_in_minutes=480&detail_level=0';

  // ────────────────────────────────────────────── 存储键
  const 键 = {
    配置: '__跑任务_配置__',
    令牌: '__跑任务_令牌__',
    统计: '__跑任务_统计__',
    日志: '__跑任务_日志__',
    运行: '__跑任务_运行中__',
    待抓: '__跑任务_待抓__',        // 主控页写、子页面读
    回传: '__跑任务_回传__',        // 子页面写、主控页读
    状态: '__跑任务_子页状态__',    // 子页面写、主控页读（在验证码页 / 正常）
    在跑任务: '__跑任务_当前任务__', // 崩溃恢复用：记着哪条任务没结清
    更新: '__跑任务_更新__',
  };

  // ────────────────────────────────────────────── 小工具
  const 等 = (毫秒) => new Promise((r) => setTimeout(r, 毫秒));
  const 现在 = () => Date.now();

  function 读(键名, 兜底) {
    try {
      const s = localStorage.getItem(键名);
      if (s === null) return 兜底;
      return JSON.parse(s);
    } catch (_) { return 兜底; }
  }
  function 写(键名, 值) {
    try { localStorage.setItem(键名, JSON.stringify(值)); } catch (_) {}
  }
  function 删(键名) {
    try { localStorage.removeItem(键名); } catch (_) {}
  }

  // ══════════════════════════════════════ GitHub 脚本更新
  // 用户脚本没有权限静默改写自身；这里仅检查版本，并跳到 Via 的原生覆盖安装页。
  function 是规范版本(值) {
    return /^\d+\.\d+\.\d+$/.test(String(值 || '').trim());
  }

  function 比较版本(甲, 乙) {
    if (!是规范版本(甲) || !是规范版本(乙)) return null;
    const a = String(甲).split('.').map(Number);
    const b = String(乙).split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (a[i] > b[i]) return 1;
      if (a[i] < b[i]) return -1;
    }
    return 0;
  }

  function 取更新状态() {
    const 原 = 读(键.更新, {});
    const 上次检查 = Number(原 && 原.上次检查);
    const 候选版本 = String(原 && 原.待更新 && 原.待更新.版本 || '').trim();
    const 待更新 = 是规范版本(候选版本) && 比较版本(候选版本, 版本) === 1
      ? {
          版本: 候选版本,
          安装链接: String(原.待更新.安装链接 || 更新安装地址),
        }
      : null;
    return {
      上次检查: Number.isFinite(上次检查) && 上次检查 > 0 ? 上次检查 : 0,
      状态: String(原 && 原.状态 || '尚未检查').slice(0, 160),
      待更新,
      检查中: 更新检查中,
    };
  }

  function 存更新状态(状态) {
    const 可存 = Object.assign({}, 状态);
    delete 可存.检查中;
    写(键.更新, 可存);
    刷新界面();
  }

  function 带更新参数(地址, 名称, 值) {
    try {
      const u = new URL(地址, location.href);
      u.searchParams.set(名称, String(值));
      return u.href;
    } catch (_) {
      const 分隔 = String(地址).includes('?') ? '&' : '?';
      return `${地址}${分隔}${encodeURIComponent(名称)}=${encodeURIComponent(String(值))}`;
    }
  }

  function 版本安装地址(目标版本) {
    if (!是规范版本(目标版本)) return 更新安装地址;
    return `https://cdn.jsdelivr.net/gh/ChunKitGitHub/new-codeg-releases@v${目标版本}/sp.user.js`;
  }

  function 取远程脚本版本(文本) {
    const 头 = String(文本 || '').slice(0, 12000);
    const m = 头.match(/^\/\/\s*@version\s+([0-9]+\.[0-9]+\.[0-9]+)\s*$/m);
    return m ? m[1] : '';
  }

  let 更新检查中 = false;

  async function 取远程更新脚本() {
    const 地址 = 带更新参数(更新检查地址, 'check', 现在());
    const 头 = { Accept: 'text/plain, application/javascript;q=0.9, */*;q=0.1' };
    if (有GM) {
      const r = await GM请求('GET', 地址, 头, undefined, 更新请求超时毫秒);
      if (!r.成功 || r.状态 < 200 || r.状态 >= 300) {
        throw new Error(r.错误 || `GitHub 返回 HTTP ${r.状态 || 0}`);
      }
      return r.文本;
    }

    const 控制 = new AbortController();
    const 定时器 = setTimeout(() => 控制.abort(), 更新请求超时毫秒);
    try {
      const r = await fetch(地址, {
        method: 'GET', cache: 'no-store', credentials: 'omit', headers: 头, signal: 控制.signal,
      });
      if (!r.ok) throw new Error(`GitHub 返回 HTTP ${r.status}`);
      return await r.text();
    } finally {
      clearTimeout(定时器);
    }
  }

  async function 检查更新(手动 = false) {
    if (是运行中()) {
      const 状态 = 取更新状态();
      状态.状态 = '任务运行中，停止后再检查更新';
      存更新状态(状态);
      return { 跳过: '任务运行中' };
    }
    if (更新检查中) return { 跳过: '正在检查' };

    const 状态 = 取更新状态();
    if (!手动 && 现在() - 状态.上次检查 < 更新检查间隔毫秒) {
      return { 跳过: '未到检查时间' };
    }

    更新检查中 = true;
    状态.上次检查 = 现在();
    状态.状态 = '正在检查 GitHub 更新…';
    存更新状态(状态);
    try {
      const 远程版本 = 取远程脚本版本(await 取远程更新脚本());
      if (!是规范版本(远程版本)) throw new Error('远程脚本缺少有效版本号');
      const 比较 = 比较版本(远程版本, 版本);
      if (比较 === null) throw new Error('版本号格式无效');
      if (比较 === 1) {
        状态.待更新 = {
          版本: 远程版本,
          安装链接: 版本安装地址(远程版本),
        };
        状态.状态 = `发现新版本 ${远程版本}`;
        return { 成功: true, 有更新: true, 版本: 远程版本 };
      }
      状态.待更新 = null;
      状态.状态 = `已是最新版本 ${版本}`;
      return { 成功: true, 有更新: false, 版本: 远程版本 };
    } catch (e) {
      状态.状态 = `检查失败：${String(e && e.message || e).slice(0, 100)}`;
      return { 成功: false, 错误: 状态.状态 };
    } finally {
      更新检查中 = false;
      存更新状态(状态);
    }
  }

  async function 立即更新() {
    if (是运行中()) {
      const 状态 = 取更新状态();
      状态.状态 = '请先停止任务再更新';
      存更新状态(状态);
      return false;
    }
    let 状态 = 取更新状态();
    if (!状态.待更新) {
      await 检查更新(true);
      状态 = 取更新状态();
    }
    if (!状态.待更新) return false;

    const 地址 = 带更新参数(状态.待更新.安装链接 || 更新安装地址,
      'version', 状态.待更新.版本);
    状态.状态 = `正在打开 ${状态.待更新.版本} 的覆盖安装页…`;
    存更新状态(状态);
    try {
      // 当前标签跳转不受移动端异步弹窗策略影响；最终覆盖仍由 Via 明确确认。
      location.href = 地址;
      return true;
    } catch (e) {
      状态.状态 = `无法打开安装页：${String(e && e.message || e).slice(0, 100)}`;
      存更新状态(状态);
      return false;
    }
  }

  // 北京时间的 y-m-d，用于按天统计（服务端也按北京时间算）
  function 北京日期(时刻 = new Date()) {
    const p = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(时刻);
    const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
    return `${v.year}-${v.month}-${v.day}`;
  }

  // 北京时间的分钟数（0~1439），时段判断用
  function 北京分钟(时刻 = new Date()) {
    const p = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(时刻);
    const v = Object.fromEntries(p.map((x) => [x.type, x.value]));
    return Number(v.hour) * 60 + Number(v.minute);
  }

  function 分钟转文本(分) {
    const h = String(Math.floor(分 / 60) % 24).padStart(2, '0');
    const m = String(分 % 60).padStart(2, '0');
    return `${h}:${m}`;
  }

  function 文本转分钟(文本) {
    const m = String(文本 || '').match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const h = Number(m[1]), mi = Number(m[2]);
    if (h > 23 || mi > 59) return null;
    return h * 60 + mi;
  }

  // expireDate 是「北京时间」字符串 2026-09-06 15:04:05，必须按 +08:00 解析。
  // 直接 new Date(那个串) 会被当本地时区，手机时区不是 +08 时会算错窗口。
  function 解析北京时刻(文本) {
    const m = String(文本 || '').match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) return null;
    return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`);
  }

  // ────────────────────────────────────────────── 配置
  // 时段配额：每条 { 起: '09:00', 止: '12:00', 单数: 20 }
  // 间隔不用你填 —— 由「时段剩余时间 ÷ 剩余单数」动态算，见 算间隔()
  const 默认配置 = {
    账号: '',            // allplat 登录账号
    密码: '',
    设备名称: '',        // 上报用的实例名，也是 claim 的 account
    接单账号: '',        // 传给 claimTask 的 account；留空则用设备名称
    通知链接: '',        // 例如 https://api.day.app/xxxxx/
    接口模板: 默认接口模板,
    时段: [
      { 起: '00:01', 止: '23:54', 单数: 1000 },
    ],
    抖动百分比: 65,      // 间隔上下浮动 ±65%，避免固定节奏
    最小间隔秒: 45,      // 再怎么赶也不快于这个
    抓取超时秒: 60,      // 等 get_rw 响应的上限

    // ── 抓取路线（按风控暴露面从小到大）
    // C 软导航：在当前标签页软跳到商品页，让页面自己发 get_rw，我们只截响应。
    //   Referer/前端自有头/风控签名全真实，不冷加载。**默认走这条。**
    软导航优先: true,
    // 严格模式：软导航失败就直接放回任务，不再降级。开着最安全。
    仅软导航: true,
    // B 后台标签页：Referer 真实但是冷加载，会触发「系统不稳定」。
    允许后台页: false,
    // A 直连 fetch get_rw：不冷加载，但 Referer 是首页、缺前端自有头，
    //   实测会被风控拦（error=90309999 + 跳 /verify/traffic/error）。
    //   **默认关闭**，除非你确认自己的环境不拦。
    允许直连: false,
    // 抓完软跳回哪里。主控页要留在这个地址上才好开下一单。
    首页地址: '/',

    // 「暂无可用任务」时等多久再问一次。单位毫秒，可以填 200。
    // 这不占时段配额（没领到就不算一单），所以设小只是多问几次接口。
    // 文档建议 shopee 用 1 秒；想抢单可以更小，但别小到把接口打爆。
    无任务退避毫秒: 1000,

    // 遇验证码时：通知你去手做，脚本在后台等你做完，做完继续抓同一条任务。
    // 关掉的话就直接放回任务（老行为）。
    等你做验证码: true,
    // 等多久。上限仍受 expireDate 收敛（shopee 上游只留 5 分钟），
    // 所以填再大也不会超过任务本身的有效期。
    验证码等待秒: 240,
  };

  function 取配置() {
    const c = Object.assign({}, 默认配置, 读(键.配置, {}));
    if (!Array.isArray(c.时段) || !c.时段.length) c.时段 = 默认配置.时段.slice();
    return c;
  }
  function 存配置(c) { 写(键.配置, c); }

  // ────────────────────────────────────────────── 日志与统计
  function 记(文本, 级别 = '常规') {
    const 全 = 读(键.日志, []);
    全.push({ 时刻: new Date().toISOString().slice(11, 19), 文本: String(文本), 级别 });
    while (全.length > 200) 全.shift();
    写(键.日志, 全);
    刷新界面();
  }

  function 取统计() {
    const s = 读(键.统计, null);
    const 今天 = 北京日期();
    if (!s || s.日期 !== 今天) {
      return { 日期: 今天, 失败: 0, 时段完成: {} };
    }
    // 清理旧版本留下的展示计数；完成数从服务器取，领取/验证码不再统计。
    delete s.完成;
    delete s.领取;
    delete s.验证码;
    if (!s.时段完成) s.时段完成 = {};
    return s;
  }
  function 存统计(s) { 写(键.统计, s); }

  function 计一次(字段, 时段键) {
    const s = 取统计();
    // 面板只把「失败」作为本机统计展示；完成总数以服务端为准。
    // 时段完成仅用于本次设备的节奏控制，不作为完成统计显示。
    if (字段 === '失败') s.失败 = (s.失败 || 0) + 1;
    if (时段键) s.时段完成[时段键] = (s.时段完成[时段键] || 0) + 1;
    存统计(s);
    刷新界面();
  }

  // ══════════════════════════════════════════ 时段与间隔
  // 时段允许跨零点（起 > 止 时视为跨天，例如 22:00~02:00）
  function 时段键(段) { return `${段.起}-${段.止}`; }

  function 在时段内(段, 分 = 北京分钟()) {
    const a = 文本转分钟(段.起), b = 文本转分钟(段.止);
    if (a === null || b === null) return false;
    return a <= b ? (分 >= a && 分 < b) : (分 >= a || 分 < b);
  }

  // 该时段总长（分钟），跨天要加 1440
  function 时段长度(段) {
    const a = 文本转分钟(段.起), b = 文本转分钟(段.止);
    if (a === null || b === null) return 0;
    return a <= b ? b - a : 1440 - a + b;
  }

  // 距时段结束还剩多少分钟
  function 时段剩余(段, 分 = 北京分钟()) {
    const b = 文本转分钟(段.止);
    if (b === null) return 0;
    const 剩 = b - 分;
    return 剩 >= 0 ? 剩 : 剩 + 1440;
  }

  function 当前时段(配置 = 取配置(), 分 = 北京分钟()) {
    for (const 段 of 配置.时段) if (在时段内(段, 分)) return 段;
    return null;
  }

  // 下一个时段还有多久开始（分钟）。用于时段外的休眠。
  function 距下个时段(配置 = 取配置(), 分 = 北京分钟()) {
    let 最近 = null;
    for (const 段 of 配置.时段) {
      const a = 文本转分钟(段.起);
      if (a === null) continue;
      let 差 = a - 分;
      if (差 <= 0) 差 += 1440;
      if (最近 === null || 差 < 最近) 最近 = 差;
    }
    return 最近;
  }

  // 核心：间隔 = 时段剩余时间 ÷ 时段剩余单数。
  // 这样无论你把单数设多少，都会均匀铺满整个时段，而不是前面猛冲后面干等。
  // 落后进度时会自动缩短间隔追赶，但不会低于 最小间隔秒。
  function 算间隔(配置 = 取配置()) {
    const 段 = 当前时段(配置);
    if (!段) return { 秒: null, 原因: '不在时段内' };

    const 已完成 = 取统计().时段完成[时段键(段)] || 0;
    const 剩余单 = Math.max(0, Number(段.单数 || 0) - 已完成);
    if (剩余单 <= 0) return { 秒: null, 原因: '本时段配额已满', 段, 已完成 };

    const 剩余分 = 时段剩余(段);
    // 时段快结束了还有单没做 → 用最小间隔冲一冲，做多少算多少
    const 理论秒 = 剩余分 <= 0 ? 配置.最小间隔秒 : (剩余分 * 60) / 剩余单;
    const 抖 = (Number(配置.抖动百分比) || 0) / 100;
    const 抖后 = 理论秒 * (1 + (Math.random() * 2 - 1) * 抖);
    const 秒 = Math.max(Number(配置.最小间隔秒) || 20, Math.round(抖后));
    return { 秒, 段, 已完成, 剩余单, 剩余分, 理论秒: Math.round(理论秒) };
  }

  // 界面上显示的进度概览
  function 时段概览(配置 = 取配置()) {
    const 统计 = 取统计();
    const 分 = 北京分钟();
    return 配置.时段.map((段) => {
      const 键名 = 时段键(段);
      const 完成 = 统计.时段完成[键名] || 0;
      const 目标 = Number(段.单数 || 0);
      const 内 = 在时段内(段, 分);
      // 按时间推进比例算「本该完成多少」，用来看是超前还是落后
      let 应完成 = 0;
      const 长 = 时段长度(段);
      if (内 && 长 > 0) 应完成 = Math.round(目标 * (1 - 时段剩余(段, 分) / 长));
      else if (!内 && 目标 > 0) {
        const a = 文本转分钟(段.起);
        应完成 = (a !== null && 距下个时段(配置, 分) !== null && 分 > a) ? 目标 : 0;
      }
      return { 键名, 起: 段.起, 止: 段.止, 目标, 完成, 应完成, 进行中: 内 };
    });
  }

  // ══════════════════════════════════════════ AES / 压缩
  // 浏览器里用 Web Crypto。subtle.encrypt 的 AES-CBC 自带 PKCS7，与服务端一致。
  let 密钥对象 = null;
  async function 取密钥() {
    if (密钥对象) return 密钥对象;
    const 原料 = new TextEncoder().encode(密钥文本);
    密钥对象 = await crypto.subtle.importKey(
      'raw', 原料, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
    return 密钥对象;
  }

  const 向量 = () => new TextEncoder().encode(向量文本);

  function 字节转base64(字节) {
    let s = '';
    const u = new Uint8Array(字节);
    for (let i = 0; i < u.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    }
    return btoa(s);
  }
  function base64转字节(b64) {
    const s = atob(String(b64).trim());
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  }

  async function 加密(对象) {
    const k = await 取密钥();
    const 明文 = new TextEncoder().encode(JSON.stringify(对象));
    const 密 = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: 向量() }, k, 明文);
    return 字节转base64(密);
  }

  async function 解密(b64) {
    const k = await 取密钥();
    const 原 = base64转字节(b64);
    if (!原.length || 原.length % 16 !== 0) {
      throw new Error('密文长度异常: ' + 原.length);
    }
    const 明 = await crypto.subtle.decrypt({ name: 'AES-CBC', iv: 向量() }, k, 原);
    return JSON.parse(new TextDecoder().decode(明));
  }

  // result 压缩。接口文档 §5.2：shopee 渠道服务端用 decodeAnyCompressedBase64，
  // zlib / zstd / 明文三种都收。浏览器没有 zstd，用 deflate（就是 zlib 格式）。
  // 注意不能用 deflate-raw —— 那是无 zlib 头的裸流，Go 的 compress/zlib 读不了。
  async function 压缩(文本) {
    const 字节 = new TextEncoder().encode(文本);
    if (typeof CompressionStream === 'undefined') {
      // 极老的浏览器：服务端能收明文 base64，退化即可
      return { 数据: 字节转base64(字节), 方式: '明文' };
    }
    const 流 = new Blob([字节]).stream().pipeThrough(new CompressionStream('deflate'));
    const 压后 = new Uint8Array(await new Response(流).arrayBuffer());
    return { 数据: 字节转base64(压后), 方式: 'deflate' };
  }

  // ══════════════════════════════════════════ 跨域：优先 GM_xmlhttpRequest
  // allplat.top 的接口一个 CORS 头都不回（实测 claimTask / completeTask /
  // failTask / getUserInfo 全都没有 Access-Control-Allow-Origin），所以从
  // shopee.tw 的页面里直接 fetch 一定被浏览器拦掉，报 "Load failed"。
  //
  // Via 提供 GM_xmlhttpRequest —— 它在扩展层发请求，天然不受 CORS 限制，
  // 这是最省事的解法：不需要中继页、不需要第二条 @match、不需要开标签页。
  // 用它的前提是脚本头里写 @grant GM_xmlhttpRequest。
  //
  // 拿不到 GM 时（@grant none 或别的浏览器）退回 postMessage 中继桥：
  // 在 allplat.top 上跑同一份脚本当中继，由它同源发请求再把结果传回来。
  const 桥地址 = 'https://allplat.top/';
  const 桥来源 = 'https://allplat.top';

  // GM 函数在 Via 里是注入到脚本作用域的全局，用 typeof 探测最稳
  // （直接引用未声明的标识符会抛 ReferenceError）。
  function 取GM请求() {
    try {
      if (typeof GM_xmlhttpRequest === 'function') return GM_xmlhttpRequest;
    } catch (_) {}
    try {
      if (typeof GM !== 'undefined' && GM && typeof GM.xmlHttpRequest === 'function') {
        return GM.xmlHttpRequest.bind(GM);
      }
    } catch (_) {}
    try {
      if (typeof window !== 'undefined' && typeof window.GM_xmlhttpRequest === 'function') {
        return window.GM_xmlhttpRequest;
      }
    } catch (_) {}
    return null;
  }

  const 有GM = !!取GM请求();

  // 用 GM_xmlhttpRequest 发一次请求，返回和桥一样的 {成功,状态,文本,新令牌}
  function GM请求(方法, 完整路径, 头, 体, 超时毫秒 = 30000) {
    const 发 = 取GM请求();
    return new Promise((定成) => {
      let 结束 = false;
      const 收 = (r, 错) => {
        if (结束) return;
        结束 = true;
        if (错) { 定成({ 成功: false, 错误: 错 }); return; }
        // GM 的响应头是一整段文本，要自己挑出 new-token
        let 新令牌 = '';
        try {
          const m = String(r.responseHeaders || '')
            .match(/^new-token:\s*(.+)$/im);
          if (m) 新令牌 = m[1].trim();
        } catch (_) {}
        定成({
          成功: true,
          状态: r.status || 0,
          文本: r.responseText || '',
          新令牌,
        });
      };
      try {
        发({
          method: 方法,
          url: 完整路径,
          headers: 头 || {},
          data: 体,
          timeout: 超时毫秒,
          // 跨站请求不要带 cookie，token 走 header
          anonymous: true,
          onload: (r) => 收(r),
          onerror: (r) => 收(null, 'GM 请求失败' +
            (r && r.status ? ' HTTP ' + r.status : '')),
          ontimeout: () => 收(null, 'GM 请求超时'),
          onabort: () => 收(null, 'GM 请求被中断'),
        });
      } catch (e) {
        收(null, 'GM 请求异常：' + (e && e.message || e));
      }
    });
  }

  const 桥 = {
    窗口: null,
    框: null,
    就绪: false,
    方式: '',
    等待: new Map(),      // 请求id → {resolve, reject, 定时器}
    序号: 0,
  };

  function 是中继页() {
    try { return location.hostname === 'allplat.top'; } catch (_) { return false; }
  }

  // ── 中继页这一侧：收请求 → 同源 fetch → 回结果
  function 启动中继() {
    window.addEventListener('message', async (事件) => {
      const 数 = 事件.data;
      if (!数 || 数.__桥 !== '跑任务' || 数.类型 !== '请求') return;

      const 回 = (载荷) => {
        try {
          事件.source.postMessage(
            Object.assign({ __桥: '跑任务', 类型: '响应', id: 数.id }, 载荷),
            事件.origin === 'null' ? '*' : 事件.origin);
        } catch (_) {}
      };

      try {
        const 控制 = new AbortController();
        const 定 = setTimeout(() => 控制.abort(), 数.超时 || 30000);
        let 响应;
        try {
          响应 = await fetch(数.路径, {
            method: 数.方法 || 'GET',
            headers: 数.头 || {},
            body: 数.体 === undefined ? undefined : 数.体,
            credentials: 'omit',
            signal: 控制.signal,
          });
        } finally { clearTimeout(定); }

        回({
          成功: true,
          状态: 响应.status,
          文本: await 响应.text(),
          新令牌: 响应.headers.get('new-token') || '',
        });
      } catch (e) {
        回({ 成功: false, 错误: String(e && e.message || e) });
      }
    });

    // 告诉父窗口/opener：我准备好了
    const 报到 = () => {
      const 消息 = { __桥: '跑任务', 类型: '就绪', 版本 };
      try { if (window.opener) window.opener.postMessage(消息, '*'); } catch (_) {}
      try { if (window.parent && window.parent !== window) window.parent.postMessage(消息, '*'); } catch (_) {}
    };
    报到();
    // 父窗口可能还没装好监听，多报几次
    let 次 = 0;
    const 定 = setInterval(() => { 报到(); if (++次 > 20) clearInterval(定); }, 300);

    // 屏幕上留个标记，别让人以为这页面白开了
    const 画 = () => {
      if (!document.body) { setTimeout(画, 100); return; }
      try {
        const d = document.createElement('div');
        d.textContent = '跑任务中继页（请勿关闭）';
        d.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;' +
          'padding:5px 9px;border-radius:6px;background:rgba(22,163,74,.9);' +
          'color:#fff;font-size:12px;font-family:-apple-system,sans-serif';
        document.body.appendChild(d);
      } catch (_) {}
    };
    画();
  }

  // ── 主控页这一侧：装桥 + 发请求
  function 装桥监听() {
    if (桥.已装监听) return;
    桥.已装监听 = true;
    window.addEventListener('message', (事件) => {
      if (事件.origin !== 桥来源) return;          // 只认 allplat.top 的消息
      const 数 = 事件.data;
      if (!数 || 数.__桥 !== '跑任务') return;

      if (数.类型 === '就绪') {
        if (!桥.就绪) {
          桥.就绪 = true;
          记(`跨域桥已就绪（${桥.方式 || '未知'}）`);
          刷新界面();
        }
        return;
      }
      if (数.类型 === '响应') {
        const 待 = 桥.等待.get(数.id);
        if (!待) return;
        桥.等待.delete(数.id);
        clearTimeout(待.定时器);
        待.resolve(数);
      }
    });
  }

  // 先试隐藏 iframe：无感、不占标签页。
  // 前提是 Via 会把脚本也注入 iframe —— 不一定会，所以有超时兜底。
  function 试iframe() {
    return new Promise((定成) => {
      装桥监听();
      try {
        if (桥.框 && 桥.框.parentNode) 桥.框.remove();
        const 框 = document.createElement('iframe');
        框.src = 桥地址;
        框.style.cssText = 'position:fixed;left:-9999px;top:-9999px;' +
          'width:1px;height:1px;border:0;opacity:0';
        框.setAttribute('aria-hidden', 'true');
        (document.body || document.documentElement).appendChild(框);
        桥.框 = 框;
        桥.窗口 = 框.contentWindow;
        桥.方式 = 'iframe';
      } catch (e) {
        定成(false);
        return;
      }
      // 6 秒内没收到「就绪」就认为 iframe 里没跑脚本
      const 截止 = 现在() + 6000;
      const 查 = () => {
        if (桥.就绪) { 定成(true); return; }
        if (现在() > 截止) {
          try { 桥.框 && 桥.框.remove(); } catch (_) {}
          桥.框 = null; 桥.窗口 = null; 桥.方式 = '';
          定成(false);
          return;
        }
        setTimeout(查, 200);
      };
      查();
    });
  }

  // iframe 不行就开后台标签页。要用户允许弹窗，但胜在一定能注入脚本。
  function 试标签页() {
    return new Promise((定成) => {
      装桥监听();
      let 窗;
      try { 窗 = window.open(桥地址, '跑任务中继'); } catch (_) { 窗 = null; }
      if (!窗) { 定成(false); return; }
      桥.窗口 = 窗;
      桥.方式 = '标签页';
      const 截止 = 现在() + 15000;
      const 查 = () => {
        if (桥.就绪) { 定成(true); return; }
        if (现在() > 截止) { 桥.方式 = ''; 定成(false); return; }
        setTimeout(查, 250);
      };
      查();
    });
  }

  let 连桥中 = null;
  async function 连桥(强制重连 = false) {
    // 有 GM_xmlhttpRequest 就不需要中继页，直接算通
    if (有GM) { 桥.就绪 = true; 桥.方式 = 'GM_xmlhttpRequest'; return true; }

    if (强制重连) {
      桥.就绪 = false;
      try { if (桥.框) 桥.框.remove(); } catch (_) {}
      桥.框 = null; 桥.窗口 = null; 桥.方式 = '';
      连桥中 = null;
    }
    if (桥.就绪 && 桥.窗口) return true;
    if (连桥中) return 连桥中;     // 并发调用共用一次连接过程

    连桥中 = (async () => {
      记('正在连接跨域桥…');
      if (await 试iframe()) return true;
      记('iframe 里没跑起来（Via 可能不注入 iframe），改开后台标签页', '警告');
      if (await 试标签页()) return true;
      记('跨域桥连接失败：请允许弹出窗口，或手动开一个 allplat.top 标签页', '错误');
      return false;
    })();
    try { return await 连桥中; }
    finally { 连桥中 = null; }
  }

  // 经桥发一次请求。返回和 fetch 类似的 {状态, 文本, 新令牌}
  // 跨域请求总入口。有 GM_xmlhttpRequest 就用它（不需要中继页），
  // 没有才退回 postMessage 桥。
  async function 桥请求(方法, 完整路径, 头, 体, 超时毫秒 = 30000) {
    if (有GM) return GM请求(方法, 完整路径, 头, 体, 超时毫秒);

    if (!(桥.就绪 && 桥.窗口)) {
      const ok = await 连桥();
      if (!ok) {
        const e = new Error('跨域通道不可用：请在脚本头加 @grant GM_xmlhttpRequest，' +
          '或给 allplat.top 也加一条 @match 让中继页生效');
        e.桥失败 = true;
        throw e;
      }
    }
    const id = 't' + (++桥.序号) + '-' + 现在();
    return new Promise((定成, 失败) => {
      const 定时器 = setTimeout(() => {
        桥.等待.delete(id);
        失败(new Error('桥请求超时'));
      }, 超时毫秒 + 3000);
      桥.等待.set(id, { resolve: 定成, reject: 失败, 定时器 });
      try {
        桥.窗口.postMessage({
          __桥: '跑任务', 类型: '请求', id,
          方法, 路径: 完整路径, 头, 体, 超时: 超时毫秒,
        }, 桥来源);
      } catch (e) {
        桥.等待.delete(id);
        clearTimeout(定时器);
        // 标签页被用户关掉会走到这里，下次调用重新连
        桥.就绪 = false;
        失败(new Error('桥已断开：' + e.message));
      }
    });
  }

  // ══════════════════════════════════════════ 接口客户端
  const 令牌 = {
    取: () => 读(键.令牌, { token: '', userId: '' }),
    存: (t) => 写(键.令牌, t),
  };

  function 是可重试网络错(错) {
    const 文 = String(错 && 错.message || 错 || '').toLowerCase();
    return ['failed to fetch', 'networkerror', 'load failed', 'timeout',
      'timed out', 'connection', 'socket', 'unexpected eof', 'aborted']
      .some((k) => 文.includes(k));
  }

  // 所有 allplat 接口都经桥发。直接 fetch 必被 CORS 拦（实测无 CORS 头）。
  async function 请求(方法, 路径, 体, 额外头 = {}, 超时毫秒 = 30000) {
    const t = 令牌.取();
    const 头 = Object.assign({
      'Content-Type': 'application/json',
      'x-token': t.token || '',
      'x-user-id': t.userId || '',
    }, 额外头);

    const r = await 桥请求(方法, 接口基址 + 路径, 头,
      体 === undefined ? undefined : JSON.stringify(体), 超时毫秒);

    if (!r.成功) throw new Error(r.错误 || '桥请求失败');

    // JWT 快过期时服务端会自动续签，不接就会跑一段时间后全部 401
    if (r.新令牌) {
      const 旧 = 令牌.取();
      令牌.存({ token: r.新令牌, userId: 旧.userId });
      记('已接收续签 token');
    }

    const 文本 = r.文本 || '';
    if (r.状态 === 401) {
      const e = new Error('令牌无效或已过期');
      e.需要登录 = true;
      throw e;
    }
    if (r.状态 >= 400) {
      throw new Error(`HTTP ${r.状态}: ${文本.slice(0, 200)}`);
    }
    try { return JSON.parse(文本); }
    catch (_) { throw new Error('响应不是 JSON: ' + 文本.slice(0, 200)); }
  }

  // 直接用令牌，不做账号密码登录。
  // 用户从已登录的客户端/网页后台把 x-token 和 userId 抄过来填进界面即可，
  // 省掉图形验证码那一整套（服务端的验证码开关不由我们控制）。
  //
  // 令牌从哪来：浏览器打开 allplat.top 登录后，开发者工具里
  // localStorage 的 token 字段就是；userId 是 /user/getUserInfo 返回的 ID。
  // 界面上有「用令牌校验」按钮，填完点一下就能确认对不对。
  async function 校验令牌() {
    const r = await 请求('GET', '/user/getUserInfo', undefined, {}, 20000);
    if (r.code !== 0) {
      const e = new Error(`令牌无效 code=${r.code} ${r.msg || ''}`);
      e.需要登录 = true;
      throw e;
    }
    const u = (r.data && (r.data.userInfo || r.data.user)) || {};
    // 服务端能认出这个 token 属于谁 → 顺手把 userId 补上，省得用户自己找
    const 拿到ID = String(u.ID != null ? u.ID : (u.id != null ? u.id : ''));
    if (拿到ID) {
      const 旧 = 令牌.取();
      if (旧.userId !== 拿到ID) 令牌.存({ token: 旧.token, userId: 拿到ID });
    }
    return {
      昵称: u.nickName || u.userName || '(未知)',
      用户ID: 拿到ID || 令牌.取().userId || '',
      权限: u.authorityId != null ? String(u.authorityId) : '',
    };
  }

  // 兼容旧调用名
  async function 校验登录() {
    try { await 校验令牌(); return true; }
    catch (e) { if (e.需要登录) return false; throw e; }
  }

  // 领取任务。无任务时返回 null（这不是错误，退避后重试即可）。
  // 请求体带 verify 字段（哪怕空串）→ 响应 data 是加密的，见文档 §4.2。
  async function 领任务(接单账号) {
    const r = await 请求('POST', '/pullTask/claimTask', {
      platform: 平台, account: 接单账号, verify: '',
    }, {}, 60000);

    if (r.code !== 0) {
      if (/暂无可用任务|no task|no available task/i.test(r.msg || '')) return null;
      throw new Error(`领取失败 code=${r.code} ${r.msg || ''}`);
    }
    if (typeof r.data !== 'string' || !r.data) throw new Error('领取响应为空');
    const 任务 = await 解密(r.data);
    if (!任务.item) throw new Error('领取的任务缺少 item');
    任务.platform = 任务.platform || 平台;
    return 任务;
  }

  // 提交结果。抛出的错带标记：honeypot(蜜罐终态) / rejected(明确拒收)
  async function 提交任务({ traceId, sku, source, 原始数据, 账号, 接口地址 }) {
    const { 数据: result } = await 压缩(原始数据);
    const 载荷 = {
      platform: 平台, traceId, sku,
      verify: '',                       // shopee 恒空
      source: source || '',
      result,
    };
    if (账号 && 账号.trim()) 载荷.account = 账号.trim();
    if (接口地址 && 接口地址.trim()) 载荷.url = 接口地址.trim();

    const r = await 请求('POST', '/pullTask/completeTask',
      { data: await 加密(载荷) }, {}, 30000);

    // 蜜罐检查必须在 code 判断之前 —— 它是终态，不能被当普通失败重试
    const 数据文本 = typeof r.data === 'string' ? r.data : JSON.stringify(r.data || '');
    if (/蜜罐/.test(r.msg || '') || /蜜罐/.test(数据文本)) {
      const e = new Error('蜜罐：' + (r.msg || 数据文本).slice(0, 120));
      e.honeypot = true;
      throw e;
    }
    if (r.code !== 0) throw new Error(`提交失败 code=${r.code} ${r.msg || ''}`);

    let 出 = {};
    if (typeof r.data === 'string' && r.data.trim()) {
      try { 出 = await 解密(r.data); }
      catch (_) { try { 出 = JSON.parse(r.data); } catch (__) { 出 = {}; } }
    } else if (r.data && typeof r.data === 'object') {
      出 = r.data;
    }
    // code=0 只代表「请求收到了」。服务端在 body 里写 success:false 才是真结论。
    // 判定必须是「字段存在且为 false」—— 老后端只回 {hasMore:false}，
    // 把字段缺失当失败会让每单都判失败。
    if (出 && typeof 出 === 'object' && 'success' in 出 && 出.success === false) {
      const e = new Error('服务端拒收：' + (出.message || JSON.stringify(出)).slice(0, 120));
      e.rejected = true;
      throw e;
    }
    return 出;
  }

  // 上报失败 = 把任务放回池子（status 2→0）并把当前账号加入排除名单。
  // sku 必须是 claim.item（主 SKU），传变体查不到。
  async function 上报失败(traceId, sku, 原因) {
    try {
      const r = await 请求('POST', '/pullTask/failTask', {
        platform: 平台, traceId, sku,
        reason: String(原因 || 'client_failed').slice(0, 480),
      }, {}, 20000);
      if (r.code !== 0) {
        const 失败原因 = String(r.msg || ('code=' + r.code));
        记(`放回任务失败 ${失败原因}`, '警告');
        return { 成功: false, 原因: 失败原因 };
      }
      记(`已放回任务 ${traceId}：${原因}`);
      return { 成功: true };
    } catch (e) {
      记(`放回任务异常 ${e.message}`, '警告');
      return { 成功: false, 原因: e.message || '请求异常' };
    }
  }

  // 任务一旦领取，就只能在服务端明确确认 failTask 成功后才清掉本地记录。
  // 否则保留记录并停机：刷新后仍会优先尝试放回，绝不再领下一单把旧任务晾到过期。
  async function 确认放回当前任务(任务, 原因) {
    const 放回 = await 上报失败(任务.traceId, 任务.item || 任务.sku, 原因);
    if (放回.成功) {
      删(键.在跑任务);
      return true;
    }
    const 明细 = 放回.原因 || '未知原因';
    记(`任务 ${任务.traceId} 未能放回，已保留当前任务并停止：${明细}`, '错误');
    await 通知('虾皮跑任务：任务放回失败，已停止',
      `任务 ${任务.traceId} 仍在领取状态：${明细}`, '放回失败');
    return false;
  }

  async function 查当日完成(接单账号) {
    try {
      const r = await 请求('POST', '/pullTask/accountDailyCount', {
        platform: 平台, accounts: [接单账号],
      }, {}, 15000);
      if (r.code !== 0) return null;
      const 行 = (r.data || []).find((x) => x.account === 接单账号);
      const 总数 = 行 ? Number(行.total) : 0;
      return Number.isFinite(总数) && 总数 >= 0 ? 总数 : null;
    } catch (_) { return null; }
  }

  // 完成数只在内存中暂存最近一次服务端结果，绝不落到 localStorage。
  // 面板打开、任务开始和上传成功后都会重新拉取；失败数才是本机当日统计。
  const 服务端完成状态 = { 日期: '', 数: null, 加载中: false, 错误: '' };
  async function 刷新服务端完成() {
    if (服务端完成状态.加载中) return null;
    const 配置 = 取配置();
    const 接单账号 = String(配置.接单账号 || 配置.设备名称 || '').trim();
    服务端完成状态.日期 = 北京日期();
    服务端完成状态.错误 = '';
    if (!接单账号) {
      服务端完成状态.数 = null;
      服务端完成状态.错误 = '未设置接单账号';
      刷新界面();
      return null;
    }
    服务端完成状态.加载中 = true;
    刷新界面();
    const 总数 = await 查当日完成(接单账号);
    服务端完成状态.加载中 = false;
    if (总数 === null) {
      服务端完成状态.数 = null;
      服务端完成状态.错误 = '服务端完成数读取失败';
    } else {
      服务端完成状态.数 = 总数;
    }
    刷新界面();
    return 总数;
  }

  // ══════════════════════════════════════════ 通知（Bark）
  // 只在需要你亲自处理的事上推：验证码、掉登录、风控、蜜罐。
  // 用 GET + 路径编码，Bark 这个形式最稳；失败不影响主流程。
  let 上次通知 = {};
  async function 通知(标题, 正文, 去重键) {
    const 配置 = 取配置();
    const 地址 = String(配置.通知链接 || '').trim();
    if (!地址) return false;
    // 同类通知 5 分钟内只推一次，免得刷屏
    if (去重键) {
      if (现在() - (上次通知[去重键] || 0) < 5 * 60 * 1000) return false;
      上次通知[去重键] = 现在();
    }
    const 基 = 地址.replace(/\/+$/, '');
    const 完整 = `${基}/${encodeURIComponent(标题)}/${encodeURIComponent(正文)}`;
    try {
      await fetch(完整, { method: 'GET', mode: 'no-cors', credentials: 'omit' });
      记(`已推送通知：${标题}`);
      return true;
    } catch (e) {
      记(`推送通知失败：${e.message}`, '警告');
      return false;
    }
  }

  // 需要人工介入时，通知里只放便于定位设备的固定信息，避免泄露任务数据。
  function 通知身份正文() {
    const 配置 = 取配置();
    const 设备名 = String(配置.设备名称 || '未设置').trim() || '未设置';
    // 实际领取任务时，接单账号留空会回退为设备名称；通知也保持同一规则。
    const 接单账号 = String(配置.接单账号 || 配置.设备名称 || '未设置').trim() || '未设置';
    return `设备名：${设备名}\n接单账号：${接单账号}`;
  }

  // 验证码与风控走专用通知：不使用通用的 5 分钟去重。
  // 前者由后台页轮询控制频率，后者只由「两次」这个明确策略控制次数。
  async function 通知验证码() {
    return 通知('Please manually slide the verification code', 通知身份正文());
  }

  async function 通知风控() {
    return 通知('Account risk control', 通知身份正文());
  }

  async function 通知风控两次() {
    await 通知风控();
    // 不等待第二条，确保当前任务仍会立即放回并停止。
    setTimeout(() => { 通知风控(); }, 10 * 1000);
  }

  // ══════════════════════════════════════ 软导航（同标签，不冷加载）
  // 为什么必须这么做：直连 fetch get_rw 会被风控拦（error=90309999 +
  // 跳 /verify/traffic/error）—— 因为 Referer 是首页、缺 Shopee 前端自有的
  // 请求头和风控签名，服务端看到「没进过详情页却来要详情数据」。
  // 那些签名是页面 JS 现场算的，伪造不了。
  //
  // 正解不是伪造上下文，而是【真的产生上下文】：软导航到商品页，
  // 让页面按自己的流程发 get_rw，我们只在旁边把响应截下来。
  // 软导航不销毁 JS 上下文，所以界面、主循环、已抓数据全程都活着。
  const 等一下 = (毫秒) => new Promise((r) => setTimeout(r, 毫秒));

  function 同源(网址) {
    try { return new URL(网址, location.href).origin === location.origin; }
    catch (_) { return false; }
  }

  function 取路径(网址) {
    try {
      const u = new URL(网址, location.href);
      return u.pathname + u.search + u.hash;
    } catch (_) { return String(网址 || ''); }
  }

  // 同一个商品页有两种地址形式，判断"到没到"要按 (shopId,itemId) 比，
  // 不能只比字符串：点了 SEO 式链接后路径不等于规范式。
  function 抽商品号(路径) {
    const s = String(路径 || '');
    let m = s.match(/\/product\/(\d{3,})\/(\d{3,})/);
    if (m) return m[1] + '.' + m[2];
    m = s.match(/-i\.(\d{3,})\.(\d{3,})/);
    if (m) return m[1] + '.' + m[2];
    return null;
  }

  function 路径等价(甲, 乙) {
    const a = 取路径(甲), b = 取路径(乙);
    if (a === b) return true;
    const x = 抽商品号(a), y = 抽商品号(b);
    return !!(x && y && x === y);
  }

  async function 等路径变成(网址, 超时 = 4000) {
    const 截止 = 现在() + 超时;
    while (现在() < 截止) {
      if (路径等价(location.href, 网址)) return true;
      await 等一下(60);
    }
    return 路径等价(location.href, 网址);
  }

  // 机制 1：点页面上现成的 <a>。最像真人 —— 路由、埋点、内部状态全走正常流程。
  function 找链接(网址) {
    const 目标 = 取路径(网址);
    const 目标号 = 抽商品号(目标);
    let 兜底 = null;
    let 全部;
    try { 全部 = document.querySelectorAll('a[href]'); } catch (_) { return null; }
    for (const a of 全部) {
      const 路 = 取路径(a.getAttribute('href') || '');
      if (路 === 目标) return a;
      if (目标号 && 抽商品号(路) === 目标号) 兜底 = 兜底 || a;
    }
    return 兜底;
  }

  async function 用链接跳(网址) {
    const a = 找链接(网址);
    if (!a) return { 成功: false, 机制: '点现成链接', 原因: '页面上没有指向目标的 <a>' };
    if (a.target && a.target !== '_self') a.target = '_self';
    a.click();
    const 到了 = await 等路径变成(网址);
    return { 成功: 到了, 机制: '点现成链接', 原因: 到了 ? '' : '点了但路径没变' };
  }

  // 机制 2：页面自己的 router。虾皮网页版是 Next.js，router 挂在 window.next.router。
  function 找路由() {
    const 候选 = [
      ['next.router', () => window.next && window.next.router],
      ['__NEXT_ROUTER__', () => window.__NEXT_ROUTER__],
      ['__NUXT__.router', () => window.$nuxt && window.$nuxt.$router],
    ];
    for (const [名, 取] of 候选) {
      let r;
      try { r = 取(); } catch (_) { continue; }
      if (r && typeof r.push === 'function') return { 名, 路由: r };
    }
    return null;
  }

  async function 用路由跳(网址) {
    const 找到 = 找路由();
    if (!找到) return { 成功: false, 机制: '页面router', 原因: '页面未暴露 router' };
    try {
      const 结果 = 找到.路由.push(取路径(网址));
      if (结果 && typeof 结果.then === 'function') await 结果.catch(() => {});
    } catch (e) {
      return { 成功: false, 机制: 'router(' + 找到.名 + ')', 原因: e.message };
    }
    const 到了 = await 等路径变成(网址);
    return { 成功: 到了, 机制: 'router(' + 找到.名 + ')', 原因: 到了 ? '' : 'push 了但路径没变' };
  }

  // 机制 3：临时插一个 <a> 再点。比 History 真一点（有真实点击事件冒泡）。
  async function 用临时链接跳(网址) {
    let a = null;
    try {
      a = document.createElement('a');
      a.href = 取路径(网址);
      a.target = '_self';
      // 不能 display:none —— 有的实现会跳过不可见元素的点击
      a.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px';
      (document.body || document.documentElement).appendChild(a);
      a.click();
    } catch (e) {
      return { 成功: false, 机制: '临时链接', 原因: e.message };
    } finally {
      // programmatic click 是同步派发的，返回时已冒泡完，可以立刻摘
      try { a && a.remove(); } catch (_) {}
    }
    const 到了 = await 等路径变成(网址);
    return { 成功: 到了, 机制: '临时链接', 原因: 到了 ? '' : '点了但路径没变' };
  }

  // 机制 4：History + popstate。通用兜底，没有点击事件但不销毁上下文。
  async function 用History跳(网址) {
    if (!window.history || typeof history.pushState !== 'function') {
      return { 成功: false, 机制: 'History', 原因: '不支持 pushState' };
    }
    try {
      history.pushState({ 来自: '跑任务' }, '', 取路径(网址));
      window.dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    } catch (e) {
      return { 成功: false, 机制: 'History', 原因: e.message };
    }
    await 等一下(700);
    const 到了 = 路径等价(location.href, 网址);
    return {
      成功: 到了, 机制: 'History',
      原因: 到了 ? '地址已改，页面是否重渲染取决于框架是否监听 popstate' : '路径没变',
    };
  }

  const 软跳机制表 = [
    ['点现成链接', 用链接跳],
    ['页面router', 用路由跳],
    ['临时链接', 用临时链接跳],
    ['History', 用History跳],
  ];

  // 成功过的机制记下来下次先试；退化成冷加载的拉黑。都存 sessionStorage，
  // 关标签页自动清，不会某天带着过期结论跑。
  const 软跳优选键 = '__跑任务_软跳优选__';
  const 软跳黑名单键 = '__跑任务_软跳黑名单__';
  // 「已发起软跳、结果未知」的标记。这是检测退化的唯一可靠办法：
  // 冷加载会销毁整个 JS 上下文，所以「发起后在本实例里检查哨兵」根本执行不到 ——
  // 那行代码连同脚本一起被销毁了。只能靠落盘的标记：
  //   软跳成功 → 代码继续跑 → 立刻清掉标记
  //   退化成冷加载 → 页面重建 → 标记留了下来 → 下一次注入读到它就知道退化了
  const 软跳发起键 = '__跑任务_软跳发起__';
  // 连续冷加载计数。软导航本不该产生新的注入，数字涨起来就是出问题了。
  const 冷载计数键 = '__跑任务_冷载计数__';

  function 读软跳优选() {
    try { return sessionStorage.getItem(软跳优选键) || ''; } catch (_) { return ''; }
  }
  function 写软跳优选(名) {
    try { if (名) sessionStorage.setItem(软跳优选键, 名); } catch (_) {}
  }
  function 读软跳黑名单() {
    try { return JSON.parse(sessionStorage.getItem(软跳黑名单键) || '[]'); } catch (_) { return []; }
  }
  function 加软跳黑名单(名) {
    try {
      const 表 = 读软跳黑名单();
      if (!表.includes(名)) {
        表.push(名);
        sessionStorage.setItem(软跳黑名单键, JSON.stringify(表));
      }
    } catch (_) {}
  }
  function 读软跳发起() {
    try { return JSON.parse(sessionStorage.getItem(软跳发起键) || 'null'); } catch (_) { return null; }
  }
  function 写软跳发起(值) {
    try {
      if (值) sessionStorage.setItem(软跳发起键, JSON.stringify(值));
      else sessionStorage.removeItem(软跳发起键);
    } catch (_) {}
  }
  function 读冷载计数() {
    try { return Number(sessionStorage.getItem(冷载计数键) || 0); } catch (_) { return 0; }
  }
  function 写冷载计数(n) {
    try {
      if (n) sessionStorage.setItem(冷载计数键, String(n));
      else sessionStorage.removeItem(冷载计数键);
    } catch (_) {}
  }

  // 这个实例是不是刚经历过一次冷加载？
  // 只能靠 sessionStorage 里遗留的「发起标记」判断 —— 见 软跳发起键 的注释。
  // 注意 window 上的标记完全没用：冷加载会连脚本一起销毁再重新注入，
  // 新实例会把它重新设成 true，看起来永远"存活"。
  function 检出退化() {
    const 发起 = 读软跳发起();
    if (!发起 || !发起.机制) return null;
    写软跳发起(null);
    加软跳黑名单(发起.机制);
    const 次 = 读冷载计数() + 1;
    写冷载计数(次);
    return { 机制: 发起.机制, 目标: 发起.目标, 第几次: 次 };
  }

  // 软导航到目标地址。明确拒绝冷加载 —— 宁可失败也不静默触发风控。
  async function 软跳到(网址) {
    if (!网址) return { 成功: false, 原因: '网址为空' };
    if (!同源(网址)) return { 成功: false, 原因: '跨域无法软导航' };
    if (路径等价(location.href, 网址)) return { 成功: true, 机制: '已在目标页' };

    const 黑 = 读软跳黑名单();
    const 优选 = 读软跳优选();
    const 顺序 = 优选
      ? [...软跳机制表.filter(([n]) => n === 优选), ...软跳机制表.filter(([n]) => n !== 优选)]
      : 软跳机制表;

    const 明细 = [];
    let 可用 = 0;
    for (const [名, 试] of 顺序) {
      if (黑.includes(名)) { 明细.push({ 机制: 名, 跳过: '已拉黑' }); continue; }
      可用++;
      // 发起前落盘。若这次退化成冷加载，本行之后的代码都不会执行，
      // 标记会留在 sessionStorage 里，由下一次注入负责判定与拉黑。
      写软跳发起({ 机制: 名, 目标: 网址, 时刻: 现在() });
      let r;
      try { r = await 试(网址); } catch (e) { r = { 成功: false, 机制: 名, 原因: e.message }; }
      // 能走到这里 = 页面没被重建 = 这次不是冷加载，清掉标记
      写软跳发起(null);
      明细.push({ 机制: r.机制 || 名, 成功: r.成功, 原因: r.原因 || '' });
      if (r.成功) {
        写软跳优选(名);
        return { 成功: true, 机制: r.机制 || 名, 明细 };
      }
    }
    return {
      成功: false,
      原因: 可用 ? '所有可用的软导航机制都没成功' : '四种软导航机制都已被拉黑',
      明细,
      全被拉黑: 可用 === 0,
    };
  }

  // ══════════════════════════════════════════ 抓 get_rw
  // 从任务里取 shopId / itemId。shopee 新后端 item 就是 itemId，
  // 旧数据可能是完整 URL，所以两个来源都试。
  function 取商品号(任务) {
    let shop = String(任务.shopId || '').trim();
    let item = String(任务.item || '').trim();
    if (!/^\d+$/.test(item)) item = '';
    if (!shop || !item) {
      const 源 = String(任务.taskUrl || 任务.url || 任务.item || '');
      let m = 源.match(/\/product\/(\d{3,})\/(\d{3,})/);
      if (!m) m = 源.match(/-i\.(\d{3,})\.(\d{3,})/);
      if (m) { shop = shop || m[1]; item = item || m[2]; }
    }
    return { shop, item };
  }

  function 拼接口地址(任务) {
    const { shop, item } = 取商品号(任务);
    if (!shop || !item) return '';
    return 取配置().接口模板
      .replace(/\{item\}/g, item)
      .replace(/\{shop\}/g, shop);
  }

  // 只认带完整 shop_id + item_id 的 get_rw 请求。商品页可能预取推荐商品，
  // 所以「接口路径对了」远远不够，必须能和当前任务逐项比对。
  function 取GetRw商品号(地址) {
    try {
      const u = new URL(String(地址 || ''), location.href);
      if (!u.pathname.includes('/api/v4/pdp/get_rw')) return null;
      const shop = String(u.searchParams.get('shop_id') || '').trim();
      const item = String(u.searchParams.get('item_id') || '').trim();
      if (!/^\d+$/.test(shop) || !/^\d+$/.test(item)) return null;
      return { shop, item, 号: `${shop}.${item}` };
    } catch (_) {
      return null;
    }
  }

  function 取任务商品号(任务) {
    const { shop, item } = 取商品号(任务 || {});
    if (!/^\d+$/.test(shop) || !/^\d+$/.test(item)) return '';
    return `${shop}.${item}`;
  }

  // get_rw 会偶发先回 error=266900002 / data:null，稍后同一请求才有真实详情。
  // 这里是所有抓取路线共用的唯一放行口：只有请求、业务码和响应商品三者都
  // 与当前任务一致时才允许提交。无效响应由监听器忽略，继续等下一次响应。
  function 校验GetRw响应(文本, 地址, 目标号) {
    const 请求商品 = 取GetRw商品号(地址);
    if (!请求商品) return { 成功: false, 原因: 'get_rw 请求缺少 shop_id 或 item_id' };
    if (!目标号) return { 成功: false, 原因: '当前任务缺少 shop_id 或 item_id' };
    if (请求商品.号 !== 目标号) {
      return { 成功: false, 原因: `get_rw 请求商品不匹配（${请求商品.号}）` };
    }
    if (!文本) return { 成功: false, 原因: 'get_rw 响应为空' };

    let 对象;
    try { 对象 = JSON.parse(文本); }
    catch (_) { return { 成功: false, 原因: 'get_rw 响应不是 JSON' }; }

    const 错误码 = 对象 && 对象.error;
    if (错误码 !== null && 错误码 !== 0) {
      return { 成功: false, 错误码, 原因: `get_rw 业务错误 error=${错误码}` };
    }
    const 商品 = 对象 && 对象.data && 对象.data.item;
    if (!商品 || typeof 商品 !== 'object') {
      return { 成功: false, 错误码, 原因: 'get_rw 响应缺少 data.item' };
    }
    const shop = String(商品.shop_id == null ? '' : 商品.shop_id).trim();
    const item = String(商品.item_id == null ? '' : 商品.item_id).trim();
    if (!/^\d+$/.test(shop) || !/^\d+$/.test(item)) {
      return { 成功: false, 错误码, 原因: 'get_rw 响应商品 ID 不完整' };
    }
    if (`${shop}.${item}` !== 目标号) {
      return { 成功: false, 错误码, 原因: `get_rw 响应商品不匹配（${shop}.${item}）` };
    }
    return { 成功: true, 数据: 文本, 地址, 错误码 };
  }

  // 路线 A：直连 fetch。不开页面 = 不冷加载 = 不触发那个「系统不稳定」。
  // 同源 + 带 cookie，等价于页面自己发的请求。
  async function 直连抓(任务) {
    const 地址 = 拼接口地址(任务);
    if (!地址) return { 成功: false, 原因: '无法拼出接口地址' };
    const 目标号 = 取任务商品号(任务);
    const 控制 = new AbortController();
    const 超时 = Math.max(5, Number(取配置().抓取超时秒) || 60) * 1000;
    const 定 = setTimeout(() => 控制.abort(), 超时);
    try {
      const 响应 = await fetch(地址, {
        credentials: 'include',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: 控制.signal,
      });
      const 文本 = await 响应.text();
      const 校验 = 校验GetRw响应(文本, 地址, 目标号);
      if (!校验.成功 && 文本 && 校验.原因 === 'get_rw 响应不是 JSON') {
        校验.片段 = 文本.slice(0, 120);
      }
      return 校验;
    } catch (e) {
      return { 成功: false, 原因: '直连异常：' + e.message, 地址 };
    } finally {
      clearTimeout(定);
    }
  }

  // 路线 B：后台标签页。主控页留在首页不动，子页面抓到数据就自杀。
  // 子页面里跑的是本脚本的「子页面模式」（见文件末尾的角色分流）。
  async function 后台页抓(任务) {
    const 地址 = String(任务.taskUrl || '').trim();
    if (!地址) return { 成功: false, 原因: '任务没有 taskUrl' };
    const 目标号 = 取任务商品号(任务);
    if (!目标号) return { 成功: false, 原因: '任务缺少 shop_id 或 item_id' };

    const 配置 = 取配置();
    const 单号 = `${任务.traceId}-${现在()}`;
    const 基础超时 = Math.max(5, Number(配置.抓取超时秒) || 60) * 1000;
    写(键.待抓, {
      单号,
      traceId: 任务.traceId,
      目标: 拼接口地址(任务),
      商品页: 地址,
      截止: 现在() + 基础超时,
    });
    删(键.回传);
    删(键.状态);

    // 关键：用 _blank 开新标签，主控页（首页）不动。
    // Via / 多数移动浏览器会在后台打开；被拦了就如实失败，不在当前页跳。
    let 窗口 = null;
    try {
      窗口 = window.open(地址, '_blank');
    } catch (e) {
      删(键.待抓);
      return { 成功: false, 原因: '开后台页异常：' + e.message };
    }
    if (!窗口) {
      删(键.待抓);
      return { 成功: false, 原因: '浏览器拦截了新标签页（请允许弹出窗口）' };
    }

  // 轮询等子页面回传。验证码页可以通知你手动处理并延长等待；
  // 风控页则是终态，立即结束当前任务，禁止继续领下一单。
    let 截止 = 现在() + 基础超时;
    let 已通知验证码 = false;
    let 碰到验证码 = false;
    let 验证码通知次数 = 0;
    let 下次验证码通知时刻 = 0;
    // 任务本身的有效期（shopee 上游只留 5 分钟），一切等待都不能越过它
    const 任务止 = 解析北京时刻(任务.expireDate);
    let 回传 = null;

    while (现在() < 截止) {
      await 等(400);

      const r = 读(键.回传, null);
      if (r && r.单号 === 单号) { 回传 = r; break; }

      const s = 读(键.状态, null);
      if (s && s.单号 === 单号 && s.状态 === '风控') {
        回传 = { 成功: false, 风控: true, 原因: s.原因 || '检测到 /verify/traffic/error 风控页' };
        break;
      }
      if (s && s.单号 === 单号 && s.状态 === '验证码') {
        碰到验证码 = true;
        // 验证码页还在时每 10 秒提醒一次，最多 10 次；回传/超时/风控后
        // 会离开这个循环，因此不会产生遗留通知。
        if (验证码通知次数 < 10 && 现在() >= 下次验证码通知时刻) {
          验证码通知次数++;
          下次验证码通知时刻 = 现在() + 10 * 1000;
          await 通知验证码();
        }
        if (!已通知验证码) {
          已通知验证码 = true;
          计一次('验证码');
          记('子页面遇到验证码，等你手动完成（做完别关那个页面）', '警告');

          if (配置.等你做验证码) {
            // 把窗口延长到 min(你设的等待时长, 任务过期时刻)
            const 想等到 = 现在() + Math.max(30, Number(配置.验证码等待秒) || 240) * 1000;
            截止 = 任务止 ? Math.min(想等到, 任务止 - 5000) : 想等到;
            // 子页面也读这个截止，两边同步延长
            const 待 = 读(键.待抓, null);
            if (待 && 待.单号 === 单号) { 待.截止 = 截止; 写(键.待抓, 待); }
            const 还有 = Math.max(0, Math.round((截止 - 现在()) / 1000));
            记(`已延长等待到 ${还有} 秒${任务止 ? '（受任务过期时间收敛）' : ''}`);
            if (还有 <= 0) break;
          } else {
            break;      // 不等你做，直接按老行为放回
          }
        }
      }
    }

    删(键.待抓);
    删(键.回传);
    删(键.状态);

    // 子页面正常情况下会自己 close()；没关掉就补一刀。
    // 验证码等待超时、风控页都留给用户查看；脚本会停止，不会继续领单。
    const 该关 = !!回传 && !回传.风控;
    try { if (该关 && 窗口 && !窗口.closed) 窗口.close(); } catch (_) {}

    if (!回传) {
      return 碰到验证码
        ? { 成功: false, 验证码: true, 已通知: true,
            原因: '等你做验证码超时（那个标签页还留着，可手动做完）' }
        : { 成功: false, 原因: '子页面超时未回传数据' };
    }
    if (回传.风控) return { 成功: false, 风控: true, 原因: 回传.原因 || '风控' };
    if (回传.验证码) return { 成功: false, 验证码: true, 原因: 回传.原因 || '验证码' };
    if (!回传.成功) return { 成功: false, 原因: 回传.原因 || '子页面抓取失败' };
    // 正常子页面已校验过一次；这里再校验，避免存储被旧页面或其它脚本写入
    // 时把错误商品/错误响应送进提交接口。
    const 校验 = 校验GetRw响应(回传.数据, 回传.地址, 目标号);
    if (!校验.成功) return { 成功: false, 原因: '子页面回传无效：' + 校验.原因 };
    // 做完验证码后抓到的，也照常算成功
    return {
      成功: true, 数据: 校验.数据, 地址: 校验.地址, 错误码: 校验.错误码,
      经过验证码: 碰到验证码,
    };
  }

  // 抓取总入口：先直连（无痕），失败再开后台页
  // 路线 C（默认，也是唯一被实测证明干净的）：
  // 在当前标签页软导航到商品页，让【页面自己】发 get_rw，我们只截响应。
  // Referer / 前端自有头 / 风控签名全部真实，因为它们本来就是真的。
  // 抓完再软跳回首页，全程不冷加载、界面和主循环不中断。
  async function 软跳抓(任务) {
    const 商品页 = String(任务.taskUrl || '').trim();
    if (!商品页) return { 成功: false, 原因: '任务没有 taskUrl' };
    if (!同源(商品页)) return { 成功: false, 原因: '任务地址跨域，无法软导航' };

    const 配置 = 取配置();
    const 回首页 = String(配置.首页地址 || '/');
    const 目标号 = 取任务商品号(任务);
    if (!目标号) return { 成功: false, 原因: '任务缺少 shop_id 或 item_id' };

    // 先装监听，再导航 —— 反过来就会漏掉页面早期发的 get_rw
    const 收集 = 装本页监听(目标号);
    let 结果;
    try {
      const 跳 = await 软跳到(商品页);
      if (!跳.成功) {
        记(`软导航失败：${跳.原因}`, '警告');
        if (跳.明细) 记('机制明细：' + JSON.stringify(跳.明细));
        return { 成功: false, 原因: '软导航失败：' + 跳.原因, 软导航失败: true };
      }
      记(`已软导航到商品页（${跳.机制}），等页面自己发 get_rw`);

      const 秒 = Math.max(5, Number(配置.抓取超时秒) || 60);
      结果 = await 收集.等结果(秒 * 1000, () => 识别验证页面());
    } finally {
      收集.停();
    }

    // 抓完（无论成败）都软跳回首页：主控页要留在首页才好开下一单
    if (!路径等价(location.href, 回首页)) {
      const 回 = await 软跳到(new URL(回首页, location.href).href);
      记(回.成功 ? '已软跳回首页' : `软跳回首页失败：${回.原因}`,
        回.成功 ? '常规' : '警告');
    }

    if (结果 && 结果.风控) {
      return { 成功: false, 风控: true, 原因: '商品页跳到了 /verify/traffic/error 风控页' };
    }
    if (结果 && 结果.验证码) {
      return { 成功: false, 验证码: true, 原因: '商品页跳到了验证码页' };
    }
    if (!结果 || !结果.成功) {
      return { 成功: false, 原因: (结果 && 结果.原因) || '等 get_rw 超时' };
    }
    return { 成功: true, 数据: 结果.数据, 地址: 结果.地址, 错误码: 结果.错误码 };
  }

  // 风控与验证码必须分开：traffic/error 是账号/会话风控终态；
  // captcha 只在明确出现验证码参数时才允许进入人工验证等待。
  function 识别验证页面(网址 = location.href) {
    try {
      const u = new URL(String(网址 || ''), location.href);
      const 路径 = u.pathname.toLowerCase();
      if (路径.includes('/verify/traffic/error')) return '风控';
      for (const 名 of u.searchParams.keys()) {
        const 小写名 = 名.toLowerCase();
        if (小写名.includes('anti_bot_tracking_id') || 小写名.includes('captcha')) {
          return '验证码';
        }
      }
    } catch (_) {}
    return null;
  }

  // 在【当前页面】上装 fetch/XHR 监听，只等目标商品的 get_rw。
  // 与子页面模式的区别：这里抓完要能干净卸掉，不能一直挂着。
  function 装本页监听(目标号) {
    // 两份引用各有用途：
    //   原始fetch —— 还原时写回去的，必须是未包装的原物，
    //     否则每抓一次就多套一层 bind，抓几十单后调用栈全是包装层。
    //   原fetch   —— 内部调用用的，bind 过（脱离 window 调 fetch 会抛 Illegal invocation）
    const 原始fetch = window.fetch;
    const 原fetch = 原始fetch && 原始fetch.bind(window);
    const 原XHR开启 = XMLHttpRequest.prototype.open;
    const 原XHR发送 = XMLHttpRequest.prototype.send;
    const 私有 = '__跑任务_本页xhr__';
    let 命中 = null;
    let 已停 = false;

    const 是目标 = (网址) => {
      const 商品 = 取GetRw商品号(网址);
      return !!商品 && !!目标号 && 商品.号 === 目标号;
    };

    const 收 = (文本, 地址) => {
      if (已停 || 命中 || !文本) return;
      const 校验 = 校验GetRw响应(文本, 地址, 目标号);
      if (校验.成功) 命中 = 校验;
    };

    if (原fetch) {
      window.fetch = function (输入, 选项) {
        let 网址 = '';
        try {
          网址 = typeof 输入 === 'string' ? 输入
            : (输入 && 输入.url) ? 输入.url : String(输入 || '');
        } catch (_) {}
        const p = 原fetch(输入, 选项);
        if (!已停 && !命中 && 是目标(网址)) {
          p.then((响应) => {
            // clone 后读副本，绝不碰原响应的 body，否则页面自己读会报错
            let 副本;
            try { 副本 = 响应.clone(); } catch (_) { return 响应; }
            副本.text().then((t) => 收(t, 网址)).catch(() => {});
            return 响应;
          }).catch(() => {});
        }
        return p;
      };
    }

    XMLHttpRequest.prototype.open = function (方法, 网址) {
      try { this[私有] = String(网址 || ''); } catch (_) {}
      return 原XHR开启.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (!已停 && 是目标(this[私有])) {
          const 址 = this[私有];
          this.addEventListener('load', () => {
            try {
              const t = this.responseType;
              const 文本 = (t === '' || t === 'text') ? this.responseText
                : (t === 'json' ? JSON.stringify(this.response) : '');
              收(文本, 址);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return 原XHR发送.apply(this, arguments);
    };

    return {
      // 轮询等命中；期间若跳到验证码/风控页就立即返回，让上层按类型处理。
      async 等结果(超时毫秒, 取验证类型) {
        const 截止 = 现在() + 超时毫秒;
        while (现在() < 截止) {
          if (命中) return 命中;
          const 类型 = 取验证类型 && 取验证类型();
          if (类型) return {
            成功: false,
            验证码: 类型 === '验证码',
            风控: 类型 === '风控',
          };
          await 等一下(150);
        }
        return 命中 || { 成功: false, 原因: '等 get_rw 超时' };
      },
      停() {
        if (已停) return;
        已停 = true;
        // 还原成【未包装的原物】，不是 bind 后的版本 —— 否则每抓一单多套一层。
        // 只在当前实现还是我们装的那个时才动，避免踩掉别人后装的 hook。
        try {
          if (原始fetch && window.fetch !== 原始fetch) window.fetch = 原始fetch;
        } catch (_) {}
        try {
          if (XMLHttpRequest.prototype.open !== 原XHR开启) {
            XMLHttpRequest.prototype.open = 原XHR开启;
          }
        } catch (_) {}
        try {
          if (XMLHttpRequest.prototype.send !== 原XHR发送) {
            XMLHttpRequest.prototype.send = 原XHR发送;
          }
        } catch (_) {}
      },
    };
  }

  // 抓取总入口。顺序按「风控暴露面从小到大」排：
  //   C 软导航（默认）→ B 后台页（冷加载）→ A 直连（Referer 假，已实测被拦）
  // 直连默认关闭：error=90309999 就是它引起的。
  async function 抓数据(任务) {
    const 配置 = 取配置();
    // 记住最后一次失败的具体原因。全都失败时要把它带出去 ——
    // 只回一句「所有路线都失败了」会让日志和 failTask 的 reason 失去线索。
    let 末次 = null;

    if (配置.软导航优先 !== false) {
      const c = await 软跳抓(任务);
      if (c.成功) { 记(`软导航抓到数据（${c.数据.length} 字符）`); return c; }
      if (c.验证码) return c;                 // 验证码要原样上抛，交给上层通知
      if (c.风控) return c;                   // 风控终态，绝不能换路线继续尝试
      末次 = c;
      记(`软导航路线失败：${c.原因}`, '警告');
      if (配置.仅软导航) return c;             // 严格模式：不再降级，避免风控
    }

    if (配置.允许后台页 !== false) {
      const b = await 后台页抓(任务);
      if (b.成功) { 记(`后台页抓到数据（${b.数据.length} 字符）`); return b; }
      if (b.验证码) return b;
      if (b.风控) return b;
      末次 = b;
      记(`后台页失败：${b.原因}`, '警告');
    }

    if (配置.允许直连) {
      记('尝试直连（注意：Referer 为首页，可能触发 error=90309999）', '警告');
      const a = await 直连抓(任务);
      if (a.成功) { 记(`直连抓到数据（${a.数据.length} 字符）`); return a; }
      记(`直连失败：${a.原因}`, '警告');
      return a;
    }

    return 末次 || { 成功: false, 原因: '没有启用任何抓取路线' };
  }

  // ══════════════════════════════════════════ 主循环
  let 在跑 = false;
  let 停止请求 = false;
  let 下次时刻 = 0;      // 界面倒计时用

  function 是运行中() { return 读(键.运行, false) === true; }
  function 设运行(值) { 写(键.运行, !!值); 刷新界面(); }

  // 校验GetRw响应 已在各抓取路线放行前拦住非零业务码；这里作为提交前的
  // 最后一层保险。266900002 / 266900504 都不能再被当作可提交数据。
  function 可忽略错误码(码) {
    return 码 === null || 码 === 0;
  }

  async function 跑一单() {
    const 配置 = 取配置();
    const 接单 = (配置.接单账号 || 配置.设备名称 || '').trim();
    if (!接单) { 记('未配置接单账号/设备名称', '错误'); return { 结果: '配置缺失' }; }

    // 领取
    let 任务;
    try {
      任务 = await 领任务(接单);
    } catch (e) {
      if (e.需要登录) {
        await 通知('虾皮跑任务：掉登录', '请重新登录 allplat', '掉登录');
        记('登录失效，已停止', '错误');
        return { 结果: '需要登录', 停止: true };
      }
      记(`领取异常：${e.message}`, '警告');
      return { 结果: '领取异常' };
    }
    if (!任务) return { 结果: '暂无任务' };

    计一次('领取');
    记(`领到任务 ${任务.traceId} item=${任务.item}`);
    // 记下未结清的任务，崩溃/刷新后能放回去，不让它烂在 status=2
    写(键.在跑任务, { traceId: 任务.traceId, sku: 任务.item, 时刻: 现在() });

    // shopee 上游只留 5 分钟，所有等待都要收敛到 expireDate 之内
    const 截止 = 解析北京时刻(任务.expireDate);
    if (截止 && 截止 - 现在() < 10000) {
      记(`任务已接近过期（expireDate=${任务.expireDate}），放回`, '警告');
      const 已放回 = await 确认放回当前任务(任务, 'expired_on_arrival');
      return 已放回
        ? { 结果: '已过期' }
        : { 结果: '任务放回失败', 停止: true };
    }

    // 抓数据
    const 抓 = await 抓数据(任务);
    if (!抓.成功) {
      if (抓.风控) {
        记(`检测到账号/会话风控，已停止：${抓.原因}`, '错误');
        await 通知风控两次();
        const 已放回 = await 确认放回当前任务(
          任务, 'shopee_traffic_control: ' + 抓.原因);
        计一次('失败');
        return { 结果: 已放回 ? '账号风控' : '任务放回失败', 停止: true };
      }
      if (抓.验证码) {
        // 后台页抓里已经通知过并按配置等待。走到这里说明验证码
        // 未在窗口内完成；放回当前任务后必须停止，防止不断领新单触发风控。
        if (!抓.已通知) {
          计一次('验证码');
          await 通知验证码();
        }
        记(`验证码未在窗口内完成，放回任务：${抓.原因}`, '警告');
        const 已放回 = await 确认放回当前任务(任务, 'shopee_captcha_pending');
        计一次('失败');
        return { 结果: 已放回 ? '验证码超时' : '任务放回失败', 停止: true };
      }
      记(`抓取失败：${抓.原因}`, '警告');
      const 已放回 = await 确认放回当前任务(任务, 'payload_timeout: ' + 抓.原因);
      计一次('失败');
      return 已放回
        ? { 结果: '抓取失败' }
        : { 结果: '任务放回失败', 停止: true };
    }

    // 业务错误码检查：风控页/异常响应不该当成有效数据提交
    if (!可忽略错误码(抓.错误码)) {
      记(`响应业务错误 error=${抓.错误码}`, '警告');
      await 通知('虾皮跑任务：接口报错',
        `error=${抓.错误码}，可能被风控`, '接口错误');
      const 已放回 = await 确认放回当前任务(
        任务, 'shopee_traffic_error: error=' + 抓.错误码);
      计一次('失败');
      return { 结果: 已放回 ? '接口错误' : '任务放回失败', 停止: true };
    }

    // 提交（带窗口内重试）
    const 交 = await 带重试提交(任务, 抓, 截止);
    if (交.成功) {
      删(键.在跑任务);
      const 段 = 当前时段(配置);
      计一次('完成', 段 ? 时段键(段) : null);
      记(`✅ 上传成功 ${任务.traceId}` + (抓.经过验证码 ? '（做过验证码）' : ''));
      if (抓.经过验证码) {
        await 通知('虾皮跑任务：验证码已通过',
          `任务 ${任务.traceId} 数据已上传成功`, '验证码通过');
      }
      // 完成数以服务端统计为唯一展示来源；异步刷新不影响下一单节奏。
      刷新服务端完成();
      return { 结果: '完成' };
    }
    if (交.放回原因) {
      const 已放回 = await 确认放回当前任务(任务, 交.放回原因);
      if (!已放回) {
        计一次('失败');
        return { 结果: '任务放回失败', 停止: true };
      }
    } else if (交.终结) {
      // 蜜罐属于服务端终态；没有 failTask 可调用，沿用原有终结清理语义。
      删(键.在跑任务);
    }
    计一次('失败');
    return { 结果: 交.结果 || '提交失败', 停止: !!交.停止 };
  }

  // 提交重试。原则：已经抓到手的数据，绝不能因为一次网络抖动就丢掉。
  // 窗口 = min(10 分钟, expireDate)；网络抖动退避 5s，服务端 500 退避 30s。
  async function 带重试提交(任务, 抓, 截止毫秒) {
    const 配置 = 取配置();
    const 窗口止 = Math.min(
      现在() + 10 * 60 * 1000,
      截止毫秒 || (现在() + 10 * 60 * 1000));

    let 轮 = 0;
    while (现在() < 窗口止) {
      轮++;
      try {
        const 出 = await 提交任务({
          traceId: 任务.traceId,
          sku: 任务.item,
          source: 任务.source,
          原始数据: 抓.数据,
          账号: (配置.设备名称 || '').trim(),
          接口地址: 抓.地址,
        });
        return { 成功: true, 出 };
      } catch (e) {
        // 蜜罐：账号被判造假，终态，不重试也不放回
        if (e.honeypot) {
          记(`蜜罐命中，已停止：${e.message}`, '错误');
          await 通知('虾皮跑任务：蜜罐', e.message.slice(0, 100), '蜜罐');
          return { 成功: false, 结果: '蜜罐', 停止: true, 终结: true };
        }
        // 服务端明确拒收：不重试，放回让别人做
        if (e.rejected) {
          记(`服务端拒收：${e.message}`, '警告');
          return { 成功: false, 结果: '被拒收', 放回原因: 'upload_rejected: ' + e.message };
        }
        if (e.需要登录) {
          await 通知('虾皮跑任务：掉登录', '提交时发现登录失效', '掉登录');
          return { 成功: false, 结果: '需要登录', 停止: true };
        }
        const 五百 = /HTTP 5\d\d/.test(e.message);
        const 可重试 = 五百 || 是可重试网络错(e);
        if (!可重试) {
          记(`提交失败（不重试）：${e.message}`, '警告');
          return { 成功: false, 结果: '提交失败', 放回原因: 'upload_failed: ' + e.message };
        }
        const 退避 = 五百 ? 30000 : 5000;
        const 剩 = 窗口止 - 现在();
        if (剩 <= 退避) break;
        记(`提交第${轮}次失败（${e.message}），${退避 / 1000}秒后重试`, '警告');
        await 等(退避);
      }
    }
    记('提交窗口耗尽', '警告');
    return { 成功: false, 结果: '窗口耗尽', 放回原因: 'upload_failed: 窗口耗尽' };
  }

  // 启动前把上次没结清的任务放回去，避免它烂在 status=2
  async function 清理遗留() {
    const 遗 = 读(键.在跑任务, null);
    if (!遗 || !遗.traceId) return true;
    记(`发现上次未结清的任务 ${遗.traceId}，放回`);
    return 确认放回当前任务(遗, 'manual_stop_inflight');
  }

  async function 主循环() {
    if (在跑) return;
    在跑 = true;
    停止请求 = false;
    try {
      if (!(await 清理遗留())) {
        // 本地还记着 status=2 的旧任务，不能冒险领取下一条。
        记('遗留任务未能放回，主循环已停止', '错误');
        设运行(false);
        return;
      }
      while (!停止请求 && 是运行中()) {
        const 配置 = 取配置();
        const 间隔 = 算间隔(配置);

        // 不在时段内 / 配额已满 → 睡到下一个时段
        if (间隔.秒 === null) {
          const 等分 = 间隔.原因 === '本时段配额已满'
            ? Math.max(1, 时段剩余(间隔.段))
            : (距下个时段(配置) || 30);
          记(`${间隔.原因}，${等分} 分钟后再看`);
          下次时刻 = 现在() + 等分 * 60 * 1000;
          刷新界面();
          await 睡到(下次时刻);
          continue;
        }

        const r = await 跑一单();
        if (r.停止) { 设运行(false); break; }

        // 「暂无任务」不算一单（没占配额），所以用单独的短退避，
        // 而不是时段算出来的那个间隔。毫秒级，用户可以设到 200。
        const 无任务 = r.结果 === '暂无任务';
        const 待毫秒 = 无任务
          ? Math.max(50, Number(配置.无任务退避毫秒) || 1000)
          : 间隔.秒 * 1000;
        const 说明 = 无任务
          ? '暂无任务'
          : `本时段 ${间隔.已完成 + (r.结果 === '完成' ? 1 : 0)}/${间隔.段.单数}`;
        记(`${说明}，等 ${待毫秒 >= 1000 ? (待毫秒 / 1000) + ' 秒' : 待毫秒 + ' 毫秒'}`);
        下次时刻 = 现在() + 待毫秒;
        刷新界面();
        await 睡到(下次时刻);
      }
    } catch (e) {
      记(`主循环异常：${e.message}`, '错误');
      设运行(false);
    } finally {
      在跑 = false;
      下次时刻 = 0;
      刷新界面();
    }
  }

  // 可被「停止」打断的睡眠。
  // 步长取 min(200ms, 剩余)：要支持 200 毫秒级的退避，
  // 原来固定 500ms 一跳会把 200ms 的等待拖成 500ms。
  async function 睡到(时刻) {
    while (现在() < 时刻) {
      if (停止请求 || !是运行中()) return;
      await 等(Math.max(1, Math.min(200, 时刻 - 现在())));
      刷新倒计时();
    }
  }

  // ══════════════════════════════════════════ 子页面模式
  // 商品页上跑的角色：只抓 get_rw，抓到就回传 + 关自己。
  // 必须在 document-start 装 hook，否则页面早期的请求就漏了。
  function 子页面模式(待抓) {
    const 原fetch = window.fetch && window.fetch.bind(window);
    const 原XHR发送 = XMLHttpRequest.prototype.send;
    const 原XHR开启 = XMLHttpRequest.prototype.open;
    let 已交 = false;

    const 目标请求 = 取GetRw商品号(待抓.目标);
    const 目标号 = 目标请求 ? 目标请求.号 : '';

    function 交差(结果) {
      if (已交) return;
      已交 = true;
      写(键.回传, Object.assign({ 单号: 待抓.单号 }, 结果));
      // 数据到手立刻关页面，不在商品页多停留一秒（少一点风控暴露）
      setTimeout(() => { try { window.close(); } catch (_) {} }, 60);
    }

    function 看URL(网址) {
      const 商品 = 取GetRw商品号(网址);
      return !!商品 && !!目标号 && 商品.号 === 目标号;
    }

    function 收响应(文本, 地址) {
      if (已交 || !文本) return;
      const 校验 = 校验GetRw响应(文本, 地址, 目标号);
      if (校验.成功) 交差(校验);
    }

    if (原fetch) {
      window.fetch = function (输入, 选项) {
        let 网址 = '';
        try {
          网址 = typeof 输入 === 'string' ? 输入
            : (输入 && 输入.url) ? 输入.url : String(输入 || '');
        } catch (_) {}
        const p = 原fetch(输入, 选项);
        if (!已交 && 看URL(网址)) {
          p.then((响应) => {
            // clone 后读副本，绝不碰原响应的 body，否则页面自己读会报错
            let 副本;
            try { 副本 = 响应.clone(); } catch (_) { return 响应; }
            副本.text().then((文本) => {
              收响应(文本, 网址);
            }).catch(() => {});
            return 响应;
          }).catch(() => {});
        }
        return p;
      };
    }

    const 私有 = '__跑任务_xhr__';
    XMLHttpRequest.prototype.open = function (方法, 网址) {
      try { this[私有] = String(网址 || ''); } catch (_) {}
      return 原XHR开启.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      try {
        if (!已交 && 看URL(this[私有])) {
          const 址 = this[私有];
          this.addEventListener('load', () => {
            try {
              const t = this.responseType;
              const 文本 = (t === '' || t === 'text') ? this.responseText
                : (t === 'json' ? JSON.stringify(this.response) : '');
              收响应(文本, 址);
            } catch (_) {}
          });
        }
      } catch (_) {}
      return 原XHR发送.apply(this, arguments);
    };

    // 验证码页：**不要交差、不要关页面**。
    // 交差意味着「这单结束了」，主控页会立刻放回任务、关掉这个标签页——
    // 那你根本没机会做验证码。正确做法是只上报「我在验证码页」，
    // 页面留着让你手做；做完 shopee 会自己跳回商品页，
    // 上面的 fetch/XHR hook 仍在位，get_rw 一到就正常交差。
    const 报状态 = (状态, 附加) => {
      if (已交) return;
      try {
        写(键.状态, Object.assign({
          单号: 待抓.单号, 状态, 地址: location.href, 时刻: 现在(),
        }, 附加 || {}));
      } catch (_) {}
    };

    let 上次状态 = '';
    const 查页面 = () => {
      if (已交) return;
      const 验证类型 = 识别验证页面(location.href);
      const 本次 = 验证类型 || '正常';
      if (本次 !== 上次状态) {
        上次状态 = 本次;
        报状态(本次, 验证类型 === '风控'
          ? { 原因: '检测到 /verify/traffic/error 风控页' } : null);
        画标记(验证类型 === '风控'
          ? '⛔ 检测到账号风控，任务已停止'
          : 验证类型 === '验证码'
            ? '⚠ 请手动完成验证，完成后不要关本页'
            : '抓取中…');
      }
    };
    // 首次调用放到文件末尾（画标记 是函数声明，会提升，但 标记 变量不会——
    // 在这里调会让首帧标记画不出来）。这里只装轮询。
    setInterval(查页面, 800);

    // 超时也要交差，让主控页别一直等。
    // 注意用 截止 而不是固定值：主控页在等验证码时会把 截止 往后推，
    // 子页面每次轮询都重读，于是等待窗口能跟着延长。
    const 查超时 = () => {
      if (已交) return;
      let 截止 = 待抓.截止 || 0;
      try {
        const 新 = 读(键.待抓, null);
        if (新 && 新.单号 === 待抓.单号 && 新.截止) 截止 = 新.截止;
      } catch (_) {}
      if (现在() > 截止) {
        交差({ 成功: false, 原因: 上次状态 === '验证码'
          ? '等你做验证码超时' : '子页面等 get_rw 超时' });
        return;
      }
      setTimeout(查超时, 1000);
    };
    setTimeout(查超时, 1000);

    // 屏幕上留个小标记，手机上能看出这是脚本开的抓取页。
    // 注意不要在这里无条件写「抓取中…」——若已经在验证码页，
    // 查页面() 已经把标记设成提示文案了，覆盖回去会让用户看不到提示。
    let 标记 = null;
    function 画标记(文本) {
      if (!document.body) { setTimeout(() => 画标记(文本), 100); return; }
      try {
        if (!标记) {
          标记 = document.createElement('div');
          标记.style.cssText = 'position:fixed;left:6px;top:6px;z-index:2147483647;' +
            'max-width:88vw;padding:5px 9px;border-radius:6px;' +
            'color:#fff;font-size:12px;line-height:1.4;' +
            'font-family:-apple-system,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.3)';
          document.body.appendChild(标记);
        }
        标记.textContent = 文本;
        标记.style.background = /风控/.test(文本)
          ? 'rgba(185,28,28,.95)'
          : /验证/.test(文本) ? 'rgba(217,119,6,.95)' : 'rgba(238,77,45,.9)';
      } catch (_) {}
    }
    // 首次绘制由 查页面() 触发（它知道当前是验证码页还是正常页）
    查页面();
  }

  // ══════════════════════════════════════════ 界面
  let 宿主 = null, 影子 = null, 面板 = null, 球 = null;
  let 元素 = {};

  const 样式 = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont,
        'PingFang SC', 'Microsoft YaHei', sans-serif; }
    .球 { position: fixed; right: 10px; bottom: 92px; width: 52px; height: 52px;
      border-radius: 50%; background: #ee4d2d; color: #fff; border: 0;
      z-index: 2147483646; font-size: 11px; font-weight: 700; line-height: 1.2;
      box-shadow: 0 3px 10px rgba(0,0,0,.3); touch-action: none; }
    .球.跑 { background: #16a34a; }
    .面板 { position: fixed; inset: auto 0 0; height: 50vh; height: 50dvh;
      background: #f6f7f9; z-index: 2147483647; display: none; flex-direction: column;
      border-radius: 16px 16px 0 0; overflow: hidden;
      box-shadow: 0 -4px 20px rgba(15,23,42,.22); }
    .面板.开 { display: flex; }
    .头 { display: flex; align-items: center; gap: 8px; padding: 10px 12px;
      background: #ee4d2d; color: #fff; flex: none; }
    .头 .题 { font-size: 14px; font-weight: 700; flex: 1; }
    .头 button { background: rgba(255,255,255,.2); color: #fff; border: 0;
      border-radius: 6px; padding: 6px 10px; font-size: 12px; font-weight: 600; }
    .体 { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 10px; }
    .卡 { background: #fff; border-radius: 8px; padding: 10px; margin-bottom: 10px;
      box-shadow: 0 1px 3px rgba(0,0,0,.06); }
    .卡题 { font-size: 12px; font-weight: 700; color: #ee4d2d; margin-bottom: 8px; }
    label { display: block; font-size: 11px; color: #555; margin: 8px 0 3px; }
    input { width: 100%; padding: 8px; border: 1px solid #dfe3e8; border-radius: 6px;
      font-size: 13px; background: #fff; color: #222; }
    input[readonly] { background: #f2f4f6; color: #666; }
    .行 { display: flex; gap: 6px; }
    .行 > * { min-width: 0; }
    .钮 { width: 100%; padding: 11px; border: 0; border-radius: 7px; font-size: 14px;
      font-weight: 700; color: #fff; background: #ee4d2d; margin-top: 10px; }
    .钮.绿 { background: #16a34a; }
    .钮.灰 { background: #64748b; }
    .钮.红 { background: #dc2626; }
    .数格 { display: grid; grid-template-columns: repeat(2, 1fr); gap: 6px; }
    .数 { background: #f8fafc; border-radius: 7px; padding: 8px 4px; text-align: center; }
    .数 b { display: block; font-size: 19px; color: #0f172a; }
    .数 span { font-size: 10px; color: #64748b; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { padding: 5px 4px; text-align: center; border-bottom: 1px solid #eef1f4; }
    th { color: #64748b; font-weight: 600; }
    tr.现 td { background: #f0fdf4; font-weight: 700; }
    .落后 { color: #dc2626; }
    .超前 { color: #16a34a; }
    .段行 { display: flex; gap: 5px; align-items: center; margin-bottom: 6px; }
    .段行 input { text-align: center; }
    .段行 .删 { flex: none; width: 34px; padding: 8px 0; border: 0; border-radius: 6px;
      background: #fee2e2; color: #dc2626; font-size: 14px; font-weight: 700; }
    .志 { max-height: 190px; overflow-y: auto; background: #0f172a; border-radius: 7px;
      padding: 7px; font-family: ui-monospace, Menlo, monospace; font-size: 10px;
      line-height: 1.5; }
    .志 div { color: #cbd5e1; word-break: break-all; }
    .志 div.警告 { color: #fbbf24; }
    .志 div.错误 { color: #f87171; }
    .提 { font-size: 10px; color: #94a3b8; margin-top: 3px; line-height: 1.4; }
    .态 { font-size: 12px; color: #334155; margin-top: 6px; }
  `;

  function 造(标签, 属性 = {}, 父 = null) {
    const e = document.createElement(标签);
    for (const [k, v] of Object.entries(属性)) {
      if (k === '类') e.className = v;
      else if (k === '文') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else e.setAttribute(k, v);
    }
    if (父) 父.appendChild(e);
    return e;
  }

  function 建界面() {
    宿主 = 造('div', { id: '跑任务宿主' });
    影子 = 宿主.attachShadow ? 宿主.attachShadow({ mode: 'closed' }) : 宿主;
    (document.body || document.documentElement).appendChild(宿主);
    造('style', { 文: 样式 }, 影子);

    球 = 造('button', { 类: '球', 文: '跑任务' }, 影子);
    面板 = 造('div', { 类: '面板' }, 影子);

    const 头 = 造('div', { 类: '头' }, 面板);
    造('span', { 类: '题', 文: '虾皮跑任务 ' + 版本 }, 头);
    const 收 = 造('button', { 文: '收起' }, 头);
    const 体 = 造('div', { 类: '体' }, 面板);

    球.addEventListener('click', () => {
      面板.classList.add('开');
      刷新界面();
      刷新服务端完成();
      检查更新(false);
    });
    收.addEventListener('click', () => 面板.classList.remove('开'));

    建令牌卡(体);
    建配置卡(体);
    建时段卡(体);
    建统计卡(体);
    建更新卡(体);
    建日志卡(体);
    刷新界面();
  }

  function 建令牌卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '① 令牌（免登录）' }, 卡);
    const t = 令牌.取();

    造('label', { 文: 'x-token（从已登录的后台复制）' }, 卡);
    元素.令牌 = 造('input', {
      type: 'text', value: t.token || '', placeholder: 'eyJhbGciOi…',
      autocapitalize: 'off', autocomplete: 'off', spellcheck: 'false',
    }, 卡);

    造('label', { 文: 'x-user-id（数字，留空会自动补）' }, 卡);
    元素.用户ID = 造('input', {
      type: 'text', value: t.userId || '', placeholder: '例如 12',
      inputmode: 'numeric',
    }, 卡);

    const 钮行 = 造('div', { 类: '行' }, 卡);
    元素.存令牌钮 = 造('button', { 类: '钮 灰', 文: '保存' }, 钮行);
    元素.校验钮 = 造('button', { 类: '钮', 文: '校验令牌' }, 钮行);
    元素.桥态 = 造('div', {
      类: '态',
      文: 有GM ? '通道：GM_xmlhttpRequest' : '通道未就绪',
    }, 卡);
    元素.登录态 = 造('div', { 类: '态', 文: '未校验' }, 卡);
    造('div', {
      类: '提',
      文: '不做账号密码登录（服务端可能开着图形验证码，手机上不好处理）。' +
        '在电脑或手机浏览器登录 allplat.top 后台，从 localStorage 里复制 token 填这里。' +
        'token 会自动续签，长期有效；失效了重新复制一次即可。',
    }, 卡);

    const 存令牌 = () => {
      令牌.存({
        token: 元素.令牌.value.trim(),
        userId: 元素.用户ID.value.trim(),
      });
    };

    元素.存令牌钮.addEventListener('click', () => {
      存令牌();
      元素.登录态.textContent = '已保存，建议点「校验令牌」确认';
      记('令牌已保存');
    });

    元素.校验钮.addEventListener('click', async () => {
      存令牌();
      if (!令牌.取().token) { 元素.登录态.textContent = '请先填 token'; return; }
      元素.校验钮.disabled = true;
      元素.登录态.textContent = '校验中…';
      try {
        const u = await 校验令牌();
        元素.用户ID.value = u.用户ID;
        元素.用户ID.setAttribute('value', u.用户ID);
        元素.登录态.textContent =
          `✅ 令牌有效：${u.昵称}（ID ${u.用户ID}${u.权限 ? ' 权限' + u.权限 : ''}）`;
        记(`令牌校验通过：${u.昵称}`);
      } catch (e) {
        元素.登录态.textContent = e.桥失败
          ? '桥未连通，无法校验：' + e.message
          : '❌ ' + e.message;
        记('令牌校验失败：' + e.message, '错误');
      } finally {
        元素.校验钮.disabled = false;
        刷新界面();
      }
    });

    // 桥卡：跨域必经之路，状态要能看见、能手动重连
    const 桥卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '② 跨域通道' }, 桥卡);
    造('div', {
      类: '提',
      文: 有GM
        ? '✅ 已检测到 GM_xmlhttpRequest，直接用它发请求，不需要中继页。'
        : '未检测到 GM_xmlhttpRequest。请在脚本头加一行 ' +
          '@grant GM_xmlhttpRequest（最省事）；' +
          '或者给 allplat.top 也加一条 @match，脚本会在那里开中继页代发请求。',
    }, 桥卡);
    const 桥钮行 = 造('div', { 类: '行' }, 桥卡);
    元素.连桥钮 = 造('button', { 类: '钮', 文: 有GM ? '测试通道' : '连接桥' }, 桥钮行);
    元素.重连钮 = 造('button', { 类: '钮 灰', 文: '重连' }, 桥钮行);
    元素.桥详情 = 造('div', {
      类: '态',
      文: 有GM ? '通道：GM_xmlhttpRequest' : '',
    }, 桥卡);

    const 连 = async (强制) => {
      元素.连桥钮.disabled = true;
      元素.重连钮.disabled = true;
      元素.桥详情.textContent = 强制 ? '重连中…' : '连接中…';
      try {
        const ok = await 连桥(强制);
        元素.桥详情.textContent = ok
          ? `✅ 通道可用（${桥.方式}）`
          : '❌ 不可用。加 @grant GM_xmlhttpRequest，或给 allplat.top 加 @match';
      } finally {
        元素.连桥钮.disabled = false;
        元素.重连钮.disabled = false;
        刷新界面();
      }
    };
    元素.连桥钮.addEventListener('click', () => 连(false));
    元素.重连钮.addEventListener('click', () => 连(true));
  }
  function 建配置卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '③ 设备与通知' }, 卡);
    const c = 取配置();

    造('label', { 文: '设备名称（上报用，也是默认接单账号）' }, 卡);
    元素.设备名称 = 造('input', { type: 'text', value: c.设备名称 || '' }, 卡);

    造('label', { 文: '接单账号（留空则用设备名称）' }, 卡);
    元素.接单账号 = 造('input', { type: 'text', value: c.接单账号 || '' }, 卡);

    造('label', { 文: '通知链接（Bark，验证码/掉登录时推送）' }, 卡);
    元素.通知链接 = 造('input', {
      type: 'text', value: c.通知链接 || '',
      placeholder: 'https://api.day.app/xxxxxxxx/',
    }, 卡);
    造('div', { 类: '提', 文: '填到结尾的斜杠即可，脚本自己拼标题和内容' }, 卡);

    造('label', { 文: 'get_rw 接口模板（{item} {shop} 会被替换）' }, 卡);
    元素.接口模板 = 造('input', { type: 'text', value: c.接口模板 || 默认接口模板 }, 卡);

    const 行 = 造('div', { 类: '行' }, 卡);
    const 左 = 造('div', {}, 行), 右 = 造('div', {}, 行);
    造('label', { 文: '最小间隔(秒)' }, 左);
    元素.最小间隔秒 = 造('input', { type: 'number', min: '5', value: String(c.最小间隔秒) }, 左);
    造('label', { 文: '抖动(%)' }, 右);
    元素.抖动百分比 = 造('input', { type: 'number', min: '0', max: '80', value: String(c.抖动百分比) }, 右);

    const 退行 = 造('div', { 类: '行' }, 卡);
    const 退左 = 造('div', {}, 退行), 退右 = 造('div', {}, 退行);
    造('label', { 文: '无任务时重问间隔(毫秒)' }, 退左);
    元素.无任务退避毫秒 = 造('input', {
      type: 'number', min: '50', max: '60000',
      value: String(c.无任务退避毫秒 != null ? c.无任务退避毫秒 : 1000),
    }, 退左);
    造('label', { 文: '抓取超时(秒)' }, 退右);
    元素.抓取超时秒 = 造('input', {
      type: 'number', min: '5', max: '300', value: String(c.抓取超时秒 || 60),
    }, 退右);
    造('div', {
      类: '提',
      文: '「暂无可用任务」不占时段配额，所以这个间隔独立于上面的任务间隔。' +
        '想抢单可以设 200 毫秒；下限 50 毫秒，别设太小把接口打爆。',
    }, 卡);

    // ── 抓取路线。这块直接决定会不会被风控，所以做成显式勾选。
    造('label', { 文: '抓取路线（按风控暴露面从小到大）' }, 卡);
    const 勾 = (父, 文字, 选中) => {
      const 行 = 造('div', { style: 'display:flex;align-items:center;gap:6px;margin:4px 0' }, 父);
      const 框 = 造('input', {
        type: 'checkbox', style: 'width:auto;flex:none;transform:scale(1.3)',
      }, 行);
      框.checked = !!选中;
      造('span', { style: 'font-size:12px;color:#334155', 文: 文字 }, 行);
      return 框;
    };
    元素.软导航优先 = 勾(卡, 'C 软导航到商品页（推荐，Referer 真实、不冷加载）',
      c.软导航优先 !== false);
    元素.仅软导航 = 勾(卡, '　└ 严格：软导航失败就放回任务，不降级',
      c.仅软导航 === true);
    元素.允许后台页 = 勾(卡, 'B 后台标签页（Referer 真实，但冷加载会弹「系统不稳定」）',
      c.允许后台页 !== false);
    元素.允许直连 = 勾(卡, 'A 直连 get_rw（不冷加载，但实测被风控拦 error=90309999）',
      c.允许直连 === true);
    造('div', {
      类: '提',
      文: '手动点商品能正常、脚本跑就报风控 → 就是 A 的问题：它从首页发请求，' +
        'Referer 和前端自有头都不对。C 让页面自己发请求，' +
        'Referer/签名全是真的，因为本来就是真的。',
    }, 卡);

    // 验证码处理策略
    const 验行 = 造('div', { 类: '行' }, 卡);
    const 验左 = 造('div', {}, 验行), 验右 = 造('div', {}, 验行);
    造('label', { 文: '遇验证码时等你做' }, 验左);
    元素.等你做验证码 = 造('input', {
      type: 'checkbox',
      style: 'width:auto;transform:scale(1.4);margin-top:6px',
    }, 验左);
    元素.等你做验证码.checked = c.等你做验证码 !== false;
    造('label', { 文: '最多等(秒)' }, 验右);
    元素.验证码等待秒 = 造('input', {
      type: 'number', min: '30', max: '600', value: String(c.验证码等待秒 || 240),
    }, 验右);
    造('div', {
      类: '提',
      文: '勾上：遇验证码会每 10 秒推送一次通知（最多 10 次），并把那个标签页留着等你手动做，' +
        '做完自动抓数据并上传，这一单不算失败。' +
        '不勾：直接放回任务给别人做。等待上限受任务过期时间收敛（shopee 只留 5 分钟）。',
    }, 卡);

    const 保存 = 造('button', { 类: '钮 灰', 文: '保存配置' }, 卡);
    元素.配置态 = 造('div', { 类: '态', 文: '' }, 卡);
    保存.addEventListener('click', () => {
      const c2 = 取配置();
      c2.设备名称 = 元素.设备名称.value.trim();
      c2.接单账号 = 元素.接单账号.value.trim();
      c2.通知链接 = 元素.通知链接.value.trim();
      c2.接口模板 = 元素.接口模板.value.trim() || 默认接口模板;
      c2.最小间隔秒 = Math.max(5, Number(元素.最小间隔秒.value) || 20);
      c2.抖动百分比 = Math.min(80, Math.max(0, Number(元素.抖动百分比.value) || 0));
      c2.无任务退避毫秒 = Math.min(60000, Math.max(50,
        Number(元素.无任务退避毫秒.value) || 1000));
      c2.抓取超时秒 = Math.min(300, Math.max(5, Number(元素.抓取超时秒.value) || 60));
      c2.软导航优先 = !!元素.软导航优先.checked;
      c2.仅软导航 = !!元素.仅软导航.checked;
      c2.允许后台页 = !!元素.允许后台页.checked;
      c2.允许直连 = !!元素.允许直连.checked;
      c2.等你做验证码 = !!元素.等你做验证码.checked;
      c2.验证码等待秒 = Math.min(600, Math.max(30, Number(元素.验证码等待秒.value) || 240));
      存配置(c2);
      元素.配置态.textContent = '已保存';
      记('配置已保存');
      setTimeout(() => { 元素.配置态.textContent = ''; }, 1500);
    });

    const 测 = 造('button', { 类: '钮 灰', 文: '测试通知' }, 卡);
    测.addEventListener('click', async () => {
      const c2 = 取配置();
      c2.通知链接 = 元素.通知链接.value.trim();
      存配置(c2);
      上次通知 = {};   // 清掉去重，测试要立刻发
      const ok = await 通知('虾皮跑任务', '通知链接测试成功');
      元素.配置态.textContent = ok ? '已发送，看手机' : '未发送（链接为空或失败）';
    });
  }

  function 建时段卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '④ 时段配额（几点到几点做多少单）' }, 卡);
    元素.时段容器 = 造('div', {}, 卡);
    造('div', {
      类: '提',
      文: '间隔不用填：脚本按「时段剩余时间 ÷ 剩余单数」自动算，' +
        '把单量均匀铺满整个时段。落后了会自动加快，但不低于最小间隔。' +
        '止 小于 起 表示跨零点（如 22:00~02:00）。',
    }, 卡);

    const 行 = 造('div', { 类: '行' }, 卡);
    const 加 = 造('button', { 类: '钮 灰', 文: '+ 加一段' }, 行);
    const 存 = 造('button', { 类: '钮', 文: '保存时段' }, 行);
    元素.时段态 = 造('div', { 类: '态', 文: '' }, 卡);

    加.addEventListener('click', () => {
      const c = 取配置();
      c.时段.push({ 起: '20:00', 止: '22:00', 单数: 10 });
      存配置(c);
      画时段行();
    });
    存.addEventListener('click', () => {
      const 新 = [];
      for (const 行元素 of 元素.时段容器.children) {
        const [起, 止, 数] = 行元素.__输入;
        const a = 文本转分钟(起.value.trim()), b = 文本转分钟(止.value.trim());
        if (a === null || b === null) {
          元素.时段态.textContent = '时间格式要是 HH:MM';
          return;
        }
        const n = Number(数.value);
        if (!Number.isFinite(n) || n < 0) {
          元素.时段态.textContent = '单数要是非负整数';
          return;
        }
        新.push({ 起: 起.value.trim(), 止: 止.value.trim(), 单数: Math.floor(n) });
      }
      if (!新.length) { 元素.时段态.textContent = '至少留一个时段'; return; }
      const c = 取配置();
      c.时段 = 新;
      存配置(c);
      元素.时段态.textContent = `已保存 ${新.length} 个时段，共 ${新.reduce((s, x) => s + x.单数, 0)} 单`;
      记(`时段已保存：${新.map((x) => `${x.起}-${x.止}×${x.单数}`).join('，')}`);
      刷新界面();
    });

    画时段行();
  }

  function 画时段行() {
    const 容 = 元素.时段容器;
    if (!容) return;
    容.textContent = '';
    const c = 取配置();
    c.时段.forEach((段, i) => {
      const 行 = 造('div', { 类: '段行' }, 容);
      const 起 = 造('input', { type: 'text', value: 段.起, placeholder: '09:00' }, 行);
      造('span', { 文: '~', style: 'font-size:12px;color:#94a3b8' }, 行);
      const 止 = 造('input', { type: 'text', value: 段.止, placeholder: '12:00' }, 行);
      const 数 = 造('input', { type: 'number', min: '0', value: String(段.单数) }, 行);
      const 删钮 = 造('button', { 类: '删', 文: '×' }, 行);
      行.__输入 = [起, 止, 数];
      删钮.addEventListener('click', () => {
        const c2 = 取配置();
        c2.时段.splice(i, 1);
        if (!c2.时段.length) c2.时段 = 默认配置.时段.slice();
        存配置(c2);
        画时段行();
        刷新界面();
      });
    });
  }

  function 建统计卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    const 标题行 = 造('div', { style: 'display:flex;align-items:center;gap:8px' }, 卡);
    造('div', { 类: '卡题', 文: '⑤ 运行与统计', style: 'flex:1;margin-bottom:8px' }, 标题行);
    元素.刷新完成钮 = 造('button', {
      文: '刷新完成数',
      style: 'border:0;border-radius:6px;padding:5px 8px;font-size:11px;color:#fff;background:#64748b',
    }, 标题行);

    元素.开关 = 造('button', { 类: '钮 绿', 文: '开始跑任务' }, 卡);
    元素.状态 = 造('div', { 类: '态', 文: '未运行' }, 卡);

    元素.数格 = 造('div', { 类: '数格', style: 'margin-top:10px' }, 卡);
    for (const [键名, 名] of [['完成', '完成（服务端）'], ['失败', '失败（本机）']]) {
      const g = 造('div', { 类: '数' }, 元素.数格);
      元素['数_' + 键名] = 造('b', { 文: '—' }, g);
      造('span', { 文: 名 }, g);
    }
    元素.完成态 = 造('div', { 类: '提', 文: '完成数从服务器读取' }, 卡);
    元素.刷新完成钮.addEventListener('click', () => 刷新服务端完成());

    元素.开关.addEventListener('click', async () => {
      if (是运行中()) {
        停止请求 = true;
        设运行(false);
        记('已手动停止');
        return;
      }
      const c = 取配置();
      if (!(c.设备名称 || c.接单账号)) {
        元素.状态.textContent = '请先填设备名称';
        return;
      }
      if (!令牌.取().token) {
        元素.状态.textContent = '请先在①里填 token';
        return;
      }
      // 通道不通就跑不了任何接口，先确认再开工，别让主循环空转报错
      if (!桥.就绪) {
        元素.状态.textContent = '正在准备跨域通道…';
        const ok = await 连桥();
        if (!ok) {
          元素.状态.textContent = '跨域通道不可用，见②的说明';
          return;
        }
      }
      刷新服务端完成();
      设运行(true);
      记('开始跑任务');
      主循环();
    });

    const 清 = 造('button', { 类: '钮 灰', 文: '清空本机失败数' }, 卡);
    清.addEventListener('click', () => {
      const s = 取统计();
      s.失败 = 0;
      存统计(s);
      记('已清空本机失败统计');
      刷新界面();
    });
  }

  function 建更新卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '⑥ 脚本更新' }, 卡);
    元素.更新当前 = 造('div', { 类: '态', 文: `当前版本：${版本}` }, 卡);
    元素.更新状态 = 造('div', { 类: '态', 文: '尚未检查' }, 卡);
    const 行 = 造('div', { 类: '行' }, 卡);
    元素.检查更新钮 = 造('button', { 类: '钮 灰', 文: '检查更新' }, 行);
    元素.立即更新钮 = 造('button', { 类: '钮', 文: '立即更新' }, 行);
    造('div', {
      类: '提',
      文: '检查 GitHub 上的公开版本。更新会打开 Via 的覆盖安装确认页；运行任务时不会检查或更新。',
    }, 卡);

    元素.检查更新钮.addEventListener('click', async () => {
      await 检查更新(true);
      刷新界面();
    });
    元素.立即更新钮.addEventListener('click', async () => {
      await 立即更新();
      刷新界面();
    });
  }

  function 建日志卡(体) {
    const 卡 = 造('div', { 类: '卡' }, 体);
    造('div', { 类: '卡题', 文: '⑦ 日志' }, 卡);
    元素.日志框 = 造('div', { 类: '志' }, 卡);
    const 清 = 造('button', { 类: '钮 灰', 文: '清空日志' }, 卡);
    清.addEventListener('click', () => { 写(键.日志, []); 刷新界面(); });
  }

  // ────────────────────────────────────────────── 刷新界面
  let 待刷新 = false;
  function 刷新界面() {
    if (待刷新 || !面板) return;
    待刷新 = true;
    const 排 = window.requestAnimationFrame || ((f) => setTimeout(f, 16));
    排(() => { 待刷新 = false; 画界面(); });
  }

  function 画界面() {
    if (!面板) return;
    const 统计 = 取统计();
    const 跑着 = 是运行中();
    const 服务端完成 = 服务端完成状态.日期 === 北京日期()
      ? 服务端完成状态.数 : null;

    if (球) {
      球.classList.toggle('跑', 跑着);
      球.textContent = 跑着 ? `跑中\n${服务端完成 === null ? '—' : 服务端完成}` : '跑任务';
    }
    if (元素.开关) {
      元素.开关.textContent = 跑着 ? '停止' : '开始跑任务';
      元素.开关.className = 跑着 ? '钮 红' : '钮 绿';
    }
    if (元素.登录态 && 令牌.取().token) {
      // 只在没有更具体信息时覆盖，别把校验结果冲掉
      if (/^未校验/.test(元素.登录态.textContent)) {
        元素.登录态.textContent = '已填 token（未校验）';
      }
    }
    if (元素.桥态) {
      元素.桥态.textContent = 桥.就绪
        ? `通道可用（${桥.方式}）`
        : (连桥中 ? '通道连接中…' : '通道未就绪');
    }

    if (元素.数_完成) {
      元素.数_完成.textContent = 服务端完成状态.加载中
        ? '…' : (服务端完成 === null ? '—' : String(服务端完成));
    }
    if (元素.数_失败) 元素.数_失败.textContent = String(统计.失败 || 0);
    if (元素.完成态) {
      元素.完成态.textContent = 服务端完成状态.加载中
        ? '正在从服务器读取完成数…'
        : 服务端完成 === null
          ? (服务端完成状态.错误 || '打开面板后从服务器读取完成数')
          : `服务端今日完成：${服务端完成}`;
    }

    const 更新 = 取更新状态();
    if (元素.更新当前) 元素.更新当前.textContent = `当前版本：${版本}`;
    if (元素.更新状态) {
      元素.更新状态.textContent = 更新.待更新
        ? `发现新版本：${更新.待更新.版本}`
        : 更新.状态;
    }
    if (元素.检查更新钮) {
      元素.检查更新钮.disabled = 跑着 || 更新.检查中;
    }
    if (元素.立即更新钮) {
      元素.立即更新钮.disabled = 跑着 || 更新.检查中 || !更新.待更新;
    }

    刷新倒计时();

    // 日志
    if (元素.日志框) {
      元素.日志框.textContent = '';
      const 全 = 读(键.日志, []);
      for (const 条 of 全.slice(-60)) {
        造('div', { 类: 条.级别 === '常规' ? '' : 条.级别,
          文: `[${条.时刻}] ${条.文本}` }, 元素.日志框);
      }
      元素.日志框.scrollTop = 元素.日志框.scrollHeight;
    }
  }

  function 刷新倒计时() {
    if (!元素.状态) return;
    const 配置 = 取配置();
    const 跑着 = 是运行中();
    if (!跑着) { 元素.状态.textContent = '未运行'; return; }
    const 间隔 = 算间隔(配置);
    const 剩 = 下次时刻 ? Math.max(0, Math.ceil((下次时刻 - 现在()) / 1000)) : 0;
    if (间隔.秒 === null) {
      元素.状态.textContent = `${间隔.原因}${剩 ? `，${剩} 秒后重查` : ''}`;
    } else {
      元素.状态.textContent =
        `本时段 ${间隔.段.起}~${间隔.段.止}：${间隔.已完成}/${间隔.段.单数}，` +
        `节奏 ${Math.round(间隔.理论秒)} 秒/单${剩 ? `，${剩} 秒后下一单` : ''}`;
    }
  }

  // ══════════════════════════════════════════ 角色分流与启动
  // 同一份脚本注入到所有 shopee 页面，靠两件事判断自己是谁：
  //   1. localStorage 里有「待抓」记录，且当前地址就是那个商品页 → 子页面
  //   2. 否则 → 主控页（显示界面）
  // 子页面绝不建界面、绝不跑主循环，避免两个角色互相干扰。
  function 判角色() {
    const 待抓 = 读(键.待抓, null);
    if (!待抓 || !待抓.商品页) return { 角色: '主控' };
    if (现在() > (待抓.截止 || 0) + 5000) return { 角色: '主控' };  // 过期记录，忽略

    // 比对商品号而不是字符串：SEO 式地址和规范式指向同一个页面
    const 抽 = (s) => {
      let m = String(s || '').match(/\/product\/(\d{3,})\/(\d{3,})/);
      if (m) return m[1] + '.' + m[2];
      m = String(s || '').match(/-i\.(\d{3,})\.(\d{3,})/);
      return m ? m[1] + '.' + m[2] : null;
    };
    const 当前号 = 抽(location.href);
    const 目标号 = 抽(待抓.商品页);
    if (当前号 && 目标号 && 当前号 === 目标号) return { 角色: '子页面', 待抓 };
    // 验证码/风控页也算子页面 —— 都是从商品页跳过去的，必须把状态回传主控。
    if (识别验证页面(location.href)) {
      return { 角色: '子页面', 待抓 };
    }
    return { 角色: '主控' };
  }

  const 角色 = 是中继页() ? { 角色: '中继' } : 判角色();

  if (角色.角色 === '中继') {
    // allplat.top 上的中继页：只做转发，不建界面、不跑任务
    启动中继();
    window.__跑任务__ = { 版本, 角色: '中继' };
    console.log(`[虾皮跑任务 ${版本}] 中继页已就绪（allplat.top）`);
  } else if (角色.角色 === '子页面') {
    // hook 必须立刻装，不等 DOM
    子页面模式(角色.待抓);
    window.__跑任务__ = { 版本, 角色: '子页面' };
  } else {
    // 主控页：等 body 再建界面
    const 启动 = () => {
      if (宿主) return;
      if (!document.body) { setTimeout(启动, 40); return; }
      建界面();
      // 每 12 小时最多检查一次；失败只更新面板状态，不影响任务流程。
      if (!是运行中()) 检查更新(false);
      // 有 GM 就直接标记通道可用，界面上不必再让用户点「连接桥」
      if (有GM) {
        桥.就绪 = true;
        桥.方式 = 'GM_xmlhttpRequest';
        记('使用 GM_xmlhttpRequest 直连（无需中继页）');
        刷新界面();
      } else {
        记('未检测到 GM_xmlhttpRequest。建议在脚本头加 ' +
          '@grant GM_xmlhttpRequest；否则需要为 allplat.top 也加 @match 走中继页', '警告');
      }
      // ★ 恢复主循环之前，先处理「上一次软跳其实退化成了冷加载」。
      // 不先自救的后果就是无限循环：冷加载 → 运行态还在 → 立刻领新任务 →
      // 又软跳 → 又冷加载，每轮都真实加载一次页面、每轮都打一次风控。
      const 退化 = 检出退化();
      if (退化) {
        记(`★「${退化.机制}」退化成了冷加载（本会话第 ${退化.第几次} 次），已拉黑`, '警告');
        const 剩 = 软跳机制表.filter(([n]) => !读软跳黑名单().includes(n)).length;

        if (退化.第几次 >= 3 || 剩 === 0) {
          // 连续退化说明这个页面上软导航根本不通，继续跑只是反复打风控
          设运行(false);
          记(剩 === 0
            ? '四种软导航机制全部退化，已停止。建议改用后台页路线或换环境'
            : `已连续 ${退化.第几次} 次冷加载，已停止，避免继续触发风控`, '错误');
          通知('虾皮跑任务：软导航不可用',
            `${退化.机制} 等机制会触发整页重载，已停止`, '软导航失败');
          刷新界面();
        } else {
          记(`还剩 ${剩} 种机制可试，先回首页再继续`);
        }

        // 无论停不停，都要先离开商品页 —— 停在商品页上会被反复判风控
        const 首页 = String(取配置().首页地址 || '/');
        if (!路径等价(location.href, 首页)) {
          软跳到(new URL(首页, location.href).href).then((r) => {
            记(r.成功 ? '已回到首页' : `回首页失败：${r.原因}（请手动回首页）`,
              r.成功 ? '常规' : '警告');
            if (是运行中()) 主循环();
          });
          setInterval(刷新倒计时, 1000);
          return;      // 回首页的回调里再拉起主循环
        }
      }

      // 上次是运行态但页面被刷新了 → 主循环需要重新拉起来
      if (是运行中()) {
        记('检测到运行态，恢复主循环');
        主循环();
      }
      // 倒计时每秒走一下
      setInterval(刷新倒计时, 1000);
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', 启动, { once: true });
      setTimeout(启动, 1200);
    } else {
      启动();
    }

    window.__跑任务__ = {
      版本,
      角色: '主控',
      取配置, 存配置,
      取统计,
      校验令牌, 校验登录, 连桥, 桥请求,
      领任务, 提交任务, 上报失败, 查当日完成,
      抓数据, 直连抓, 软跳抓, 后台页抓,
      软跳到, 装本页监听, 识别验证页面,
      软跳诊断: () => ({
        优选机制: 读软跳优选(),
        黑名单: 读软跳黑名单(),
        // 本会话发生过几次「软跳退化成冷加载」。软导航正常时应恒为 0。
        冷加载次数: 读冷载计数(),
        待判发起: 读软跳发起(),
        当前路径: 取路径(location.href),
        页面router: 找路由() ? 找路由().名 : '未找到',
        商品链接数: (() => {
          try {
            return [...document.querySelectorAll('a[href]')]
              .filter((a) => /\/product\/\d+\/\d+|-i\.\d+\.\d+/
                .test(a.getAttribute('href') || '')).length;
          } catch (_) { return -1; }
        })(),
      }),
      清软跳记忆() {
        try {
          sessionStorage.removeItem(软跳优选键);
          sessionStorage.removeItem(软跳黑名单键);
          sessionStorage.removeItem(软跳发起键);
          sessionStorage.removeItem(冷载计数键);
        } catch (_) {}
        return '已清除软跳优选、黑名单、冷加载计数';
      },
      算间隔, 时段概览, 当前时段,
      通知,
      比较版本, 取更新状态, 检查更新, 立即更新,
      开始() { 设运行(true); 主循环(); return '已开始'; },
      停止() { 停止请求 = true; 设运行(false); return '已停止'; },
      显示() {
        if (面板) 面板.classList.add('开');
        刷新界面();
        刷新服务端完成();
        检查更新(false);
      },
      隐藏() { if (面板) 面板.classList.remove('开'); },
      // 排查用：把内部工具也暴露出来
      内部: { 加密, 解密, 压缩, 解析北京时刻, 北京分钟, 拼接口地址 },
    };

    console.log(`[虾皮跑任务 ${版本}] 主控页已就绪，点右下角悬浮球打开界面`);
  }
})();
