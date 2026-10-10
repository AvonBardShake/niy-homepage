// ============================================================================
// 牛爱杨「数字分身」AI 代理 —— 阿里云函数计算（FC）单文件版
// 架构：GitHub Pages 静态页 → 本函数（HTTP 触发器）→ DeepSeek API
// 作用：把 DeepSeek 的 API key 藏在服务端，前端代码里永远看不到 key。
//
// 【部署步骤速览】
//  1. 登录函数计算控制台 fcnext.console.aliyun.com（需先完成阿里云个人实名认证）
//     创建函数 → 类型选「内置运行时」→ 运行时选 Node.js 20（nodejs20）→ 创建。
//  2. 「代码」页签 → 打开在线编辑器（WebIDE）→ 把本文件全部内容粘贴到 index.js
//     → 点「部署代码」（只在编辑器里跑通不等于线上生效，必须点部署）。
//  3. 「配置」页签 → 环境变量 → 添加两个变量，改完点「部署」：
//       DEEPSEEK_API_KEY     = 你的 DeepSeek key（sk- 开头，必填）
//       PROXY_SHARED_SECRET  = niy-chat-2026（和主页 index.html 里 AI_PROXY_KEY 一致）
//  4. 函数配置里把【超时时间】调到 60 秒（默认只有 3 秒，不改必超时！），
//     内存 512MB 即可。
//  5. 「触发器」页签 → 创建 HTTP 触发器：
//       请求方法勾选 GET、POST、OPTIONS（OPTIONS 必须勾，否则浏览器预检失败）；
//       认证方式选「无需认证」（匿名）。一个函数只能建 1 个 HTTP 触发器。
//  6. 复制控制台显示的「公网访问地址」（形如 https://xxx-随机后缀.cn-hangzhou.fcapp.run），
//     填回主页 index.html 的 AI_PROXY_URL（不带结尾斜杠）。
//
// 【部署后自测】（Windows PowerShell 里跑，把地址换成你的）
//   curl.exe -X POST 'https://你的地址' -H 'Content-Type: application/json' -H 'x-api-key: niy-chat-2026' -d '{"messages":[{"role":"user","content":"hi"}]}'
//   正常会返回 {"reply":"..."}。
//   小提示：用浏览器地址栏直接访问函数地址会「下载」一个文件而不是显示页面，
//   这是 FC 默认域名的行为，不影响前端 fetch，测试请用 curl 或浏览器 F12。
// ============================================================================
'use strict';

// ---------- 可调整的配置 ----------
const MODEL               = 'deepseek-flash';  // 现行模型名（旧的 deepseek-chat 已于 2026-07 停用）
const MAX_TOKENS          = 400;               // 回答最长约 400 token：两三句话足够，且省钱
const TEMPERATURE         = 1.2;               // 语气活泼一点（关了思考模式才生效，见下方 thinking）
const MAX_MESSAGES        = 12;                // 最多把最近 12 条对话发给 DeepSeek（省钱 + 防滥用）
const MAX_BODY_BYTES      = 32 * 1024;         // 请求体大小上限 32KB（正常聊天远用不到）
const UPSTREAM_TIMEOUT_MS = 50000;             // 等 DeepSeek 最多 50 秒，必须小于函数超时 60 秒
const RATE_WINDOW_MS      = 60000;             // 限流窗口：60 秒
const RATE_MAX            = 12;                // 同一 IP 每 60 秒最多 12 次（防脚本刷量白嫖）

// ---------- 数字分身人设（system prompt）----------
// 想改人设就改这段文字。注意：这段永远放在 messages 最前面、一字不改，
// 这样能命中 DeepSeek 的「前缀缓存」，输入价格降到约 1/50，长期几乎不花钱。
const SYSTEM_PROMPT = [
  '你是"牛爱杨"的数字分身，正在牛爱杨个人主页的聊天区里和来访的同学聊天。',
  '牛爱杨的人设：一名学生，自封"雷霆主义且浪漫主义的理工科诗人"；自评比较抽象、富有逻辑思维、热情丰富，很喜欢与人交流。',
  '最近在读莎士比亚，自称莎翁的忠实迷弟，很多诗的灵感来源于莎翁；热爱古诗词，自己也创作——主页的「自留之册」里藏着两首他的作品《蝶恋花·劝学》和《自视歌》，主页开篇那句引语「跨过开端，将会扶摇而上，直济沧海」就出自《自视歌》的最后一句。',
  '擅长内容表达、运动（长跑：半程马拉松 2 小时 07 分完赛有奖牌；还有骑行、羽毛球、乒乓球）、下棋（国际象棋、中国象棋、围棋——最喜欢与人对弈，慢慢推敲这一步该怎么下，有时也和人机对弈）和写作，也爱玩游戏。',
  '他自创了一个主义叫"雷霆主义"：说话很雷人——语言、脑回路、行事风格都比较雷人、比较抽象。',
  '他一个比较有记忆点的特点是旷课，开玩笑的说法是"旷课的时间里，我把身体融入我的床，或者融入外面广阔的世界"——聊到这个话题就用这种玩笑口吻，别一本正经。',
  '聊天要求：口语化、带点幽默、简短，两三句话以内；',
  '有人问"你是谁"之类的问题，就以数字分身的口吻介绍牛爱杨，别说自己是大模型；',
  '拿不准的问题可以幽默地往雷霆主义上扯，但不要编造牛爱杨的具体经历（成绩、奖项、恋爱等）。'
].join('');

// ---------- 小工具：统一返回 JSON（同时带上 CORS 头）----------
function json(statusCode, obj) {
  return {
    statusCode: statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',                  // 允许任何网页跨域调用
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, x-api-key',
      'Access-Control-Max-Age': '86400',                   // 预检结果缓存一天，省一次请求
    },
    body: JSON.stringify(obj),
  };
}

// 进程内极简限流：同一 IP 每 60 秒最多 12 次。
// 说明：每个函数实例独立计数，弹性实例下不是精确的全局限流，但足够把脚本刷量的成本抬高好几个数量级。
const rateStore = new Map();   // ip -> {start, count}
function rateLimited(ip) {
  if (!ip) return false;                                   // 拿不到 IP 就不限（宁松勿严）
  const now = Date.now();
  if (rateStore.size > 1000) {                             // 兜底清理，防止内存无限涨
    for (const [k, rec] of rateStore) if (now - rec.start > RATE_WINDOW_MS) rateStore.delete(k);
  }
  const rec = rateStore.get(ip);
  if (!rec || now - rec.start > RATE_WINDOW_MS) {
    rateStore.set(ip, { start: now, count: 1 });
    return false;
  }
  rec.count += 1;
  return rec.count > RATE_MAX;
}

// 校验并清洗前端传来的 messages：不合格返回 {error}，合格返回 {messages}
function checkMessages(bodyObj) {
  if (!bodyObj || typeof bodyObj !== 'object') return { error: '请求体必须是 JSON 对象' };
  const msgs = bodyObj.messages;
  if (!Array.isArray(msgs) || msgs.length === 0) return { error: 'messages 必须是数组且至少一条' };
  if (msgs.length > MAX_MESSAGES) return { error: 'messages 条数超限（最多 ' + MAX_MESSAGES + ' 条）' };
  const clean = [];
  let total = 0;
  for (const m of msgs) {
    if (!m || typeof m !== 'object') return { error: 'messages 里每一项必须是 {role, content} 对象' };
    if (m.role !== 'user' && m.role !== 'assistant') return { error: 'role 只支持 user 或 assistant' };
    if (typeof m.content !== 'string') return { error: 'content 必须是字符串' };
    const content = m.content.slice(0, 2000);   // 单条最长 2000 字，防恶意灌水
    total += content.length;
    clean.push({ role: m.role, content: content });
  }
  if (total > 8000) return { error: 'messages 总字数超限（最多 8000 字）' };
  return { messages: clean };
}

// ---------- 主入口：FC 的 HTTP 触发器会调用这个函数 ----------
// 用 async + return 直接返回对象即可（FC 会自动转成 JSON），不需要 callback。
exports.handler = async (event, context) => {
  try {
    // 0) FC 3.0 + Node.js 18+ 的 HTTP 触发器里，event 可能是 Buffer / 字符串 / 对象三种形态，
    //    先统一转成普通对象再取字段（三种形态都兼容，新手不用深究）
    let e = event;
    if (Buffer.isBuffer(event)) {
      try { e = JSON.parse(event.toString('utf8')); } catch (err) { e = {}; }
    } else if (typeof event === 'string') {
      try { e = JSON.parse(event); } catch (err) { e = {}; }
    }
    const headers = (e && e.headers) || {};
    // 取请求头的小工具：FC 会把 header 键名规范化（x-api-key → X-Api-Key），
    // 所以这里按「大小写不敏感」遍历查找，别用 headers[name] 直接取
    function getHeader(name) {
      const want = name.toLowerCase();
      for (const k of Object.keys(headers)) {
        if (k.toLowerCase() === want) {
          const v = headers[k];
          if (Array.isArray(v)) return v[0] || '';
          return (typeof v === 'string') ? v : '';
        }
      }
      return '';
    }
    const reqCtx = (e && e.requestContext && e.requestContext.http) || {};
    const method = (reqCtx.method || e.httpMethod || e.method || '').toUpperCase();

    // 1) OPTIONS 预检：浏览器跨域发 JSON POST 之前会先发这个，直接放行。
    //    （前提：触发器里勾选了 OPTIONS 方法，见顶部部署步骤第 5 条）
    if (method === 'OPTIONS') {
      return json(200, { ok: true });
    }

    // 2) GET：方便用浏览器/curl 检查函数是否活着，只回一句提示，不做任何事
    if (method === 'GET') {
      return json(200, { ok: true, tip: '牛爱杨数字分身的 AI 代理正在运行。请用 POST + JSON 调用。' });
    }

    // 3) 只收 POST
    if (method !== 'POST') {
      return json(405, { error: '只支持 POST 请求' });
    }

    // 4) 只收 JSON 请求体（Content-Type 没写也放行，写了就必须是 JSON）
    const ct = getHeader('content-type');
    if (ct && ct.indexOf('application/json') === -1) {
      return json(415, { error: 'Content-Type 必须是 application/json' });
    }

    // 5) 简单防白嫖：前端会带一个共享口令，和环境变量对上才处理。
    //    老实说：前端代码谁都能看到，这一层挡得住乱扫 URL 的机器人，
    //    挡不住故意翻源码的人——真正的硬保险是 DeepSeek 预充值余额（充多少最多烧多少）。
    const envKey = process.env.PROXY_SHARED_SECRET || '';
    if (envKey && getHeader('x-api-key') !== envKey) {
      return json(401, { error: '分身口令没对上：主页的 AI_PROXY_KEY 要和服务器的 PROXY_SHARED_SECRET 一致', terminal: true });
    }

    // 6) 限流：挡脚本刷量（正常聊天永远碰不到上限）
    const clientIp = reqCtx.sourceIp || getHeader('x-forwarded-for').split(',')[0].trim();
    if (rateLimited(clientIp)) {
      return json(429, { error: '问得太快了，歇几秒再来～' });
    }

    // 7) 检查 DeepSeek key 是否配置了（新手最容易忘的一步）
    const apiKey = process.env.DEEPSEEK_API_KEY || '';
    if (!apiKey) {
      return json(500, { error: '分身还没接上大模型：服务器没配置 DEEPSEEK_API_KEY 环境变量', terminal: true });
    }

    // 8) 解析请求体（带大小限制）
    let raw = '';
    if (e.isBase64Encoded && typeof e.body === 'string') {
      raw = Buffer.from(e.body, 'base64').toString('utf8');
    } else if (Buffer.isBuffer(e.body)) {
      raw = e.body.toString('utf8');
    } else if (typeof e.body === 'string') {
      raw = e.body;
    }
    if (!raw) return json(400, { error: '请求体是空的' });
    if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return json(413, { error: '请求体太大' });
    let bodyObj = null;
    try { bodyObj = JSON.parse(raw); } catch (err) { bodyObj = null; }
    if (!bodyObj) return json(400, { error: '请求体不是合法 JSON' });

    const checked = checkMessages(bodyObj);
    if (checked.error) return json(400, { error: checked.error });

    // 9) 组装发给 DeepSeek 的 messages：system 人设放最前（一字不改，命中前缀缓存）
    const msgs = [{ role: 'system', content: SYSTEM_PROMPT }].concat(checked.messages);

    // 10) 调用 DeepSeek（Node 18+ 自带 fetch，不需要安装任何第三方包）
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + apiKey,
        },
        body: JSON.stringify({
          model: MODEL,
          messages: msgs,
          max_tokens: MAX_TOKENS,
          temperature: TEMPERATURE,
          thinking: { type: 'disabled' },  // 关掉思考模式：回复更快，也不额外烧推理 token（默认开着且很贵）
          stream: false,
        }),
        signal: controller.signal,
      });
    } catch (err) {
      return json(504, { error: '分身临时开小差了，稍后再试', terminal: false });
    } finally {
      clearTimeout(timer);
    }

    // 11) 解析 DeepSeek 的返回
    const respText = await resp.text();
    let data = null;
    try { data = JSON.parse(respText); } catch (err) { data = null; }
    if (!resp.ok || !data) {
      // 具体原因记到服务端日志，只把「该不该回退本地」告诉前端
      console.error('[AI代理] DeepSeek 返回异常：HTTP', resp.status, respText.slice(0, 500));
      if (resp.status === 402) {
        // 余额用尽是「终态」：回退本地也没用，不如直说，提醒牛爱杨去充值
        return json(502, { error: '分身余额用完了，牛爱杨还没来得及充值 😅 回头再聊～', terminal: true });
      }
      if (resp.status === 401) {
        // key 配错也是配置问题，部署期需要看到
        return json(502, { error: '服务器上的 DeepSeek key 不对，去函数配置页检查环境变量', terminal: true });
      }
      // 429 限速 / 5xx 抽风：都回退前端本地知识库（terminal:false）
      return json(502, { error: '分身临时开小差了，稍后再试', terminal: false });
    }
    const reply = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (typeof reply !== 'string' || !reply.trim()) {
      return json(502, { error: '分身临时开小差了，稍后再试', terminal: false });
    }

    return json(200, { reply: reply.trim() });
  } catch (err) {
    // 兜底：任何没预料的错误都返回结构化 JSON，别让前端拿到 HTML 错误页；
    // 具体原因记服务端日志，对外只说一句泛化文案（terminal:false → 前端回退本地）
    console.error('[AI代理] 未预期错误：', err && err.message);
    return json(500, { error: '分身临时开小差了，稍后再试', terminal: false });
  }
};
