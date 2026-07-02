/*
 * ChatGPT / Codex -> CPA / sub2api  本地离线转换
 * 全部逻辑在浏览器内执行，不发起任何网络请求。
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const inputEl = $("input");
  const outputEl = $("output");
  const statusEl = $("status");

  let lastText = "";
  let lastFilename = "";
  let lastIsTar = false;
  let lastTarBytes = null;

  // ---------- helpers ----------
  function setStatus(text, cls = "") {
    statusEl.className = "status " + cls;
    statusEl.textContent = text;
  }

  function selectedMode() {
    const el = document.querySelector('input[name="mode"]:checked');
    return el ? el.value : "cpa";
  }

  function clean(obj) {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (v !== "" && v !== null && v !== undefined) out[k] = v;
    }
    return out;
  }

  // decode a JWT payload (base64url) -> object, tolerant of errors
  function jwtPayload(jwt) {
    if (!jwt || typeof jwt !== "string") return {};
    const parts = jwt.split(".");
    if (parts.length < 2) return {};
    try {
      let s = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      s += "=".repeat((4 - (s.length % 4)) % 4);
      const bin = atob(s);
      const json = decodeURIComponent(
        Array.prototype.map
          .call(bin, (c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
          .join("")
      );
      return JSON.parse(json);
    } catch (_) {
      return {};
    }
  }

  function isoFromExp(exp) {
    const n = Number(exp);
    if (!Number.isFinite(n) || n <= 0) return "";
    return new Date(n * 1000).toISOString().replace(".000Z", "Z");
  }

  function nowIso() {
    return new Date().toISOString().replace(".000Z", "Z");
  }

  // ---------- input parsing ----------
  // Returns an array of "source records" (plain objects), whatever the shape.
  function parseRecords(raw) {
    const text = (raw || "").trim();
    if (!text) return [];

    // 1) Try a single JSON value first (object or array).
    try {
      const val = JSON.parse(text);
      return flattenSource(val);
    } catch (_) {
      /* fall through to JSONL */
    }

    // 2) JSONL: one JSON object per non-empty line.
    const records = [];
    const lines = text.split(/\r?\n/);
    let bad = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) continue;
      try {
        const val = JSON.parse(t);
        for (const r of flattenSource(val)) records.push(r);
      } catch (_) {
        bad++;
      }
    }
    if (records.length === 0 && bad > 0) {
      throw new Error("无法解析输入：既不是有效 JSON，也不是有效 JSONL。");
    }
    return records;
  }

  // Expand containers (arrays, sub2api bundles) into a flat list of records.
  function flattenSource(val) {
    if (Array.isArray(val)) {
      const out = [];
      for (const item of val) {
        for (const r of flattenSource(item)) out.push(r);
      }
      return out;
    }
    if (val && typeof val === "object") {
      // sub2api / paginated containers: { data|items|accounts|list: [...] }
      for (const key of ["accounts", "items", "data", "list"]) {
        if (Array.isArray(val[key])) {
          const out = [];
          for (const item of val[key]) {
            for (const r of flattenSource(item)) out.push(r);
          }
          return out;
        }
      }
      return [val];
    }
    return [];
  }

  // ---------- normalization ----------
  // Pull a unified account model out of any supported record shape.
  function normalize(src, backfill) {
    // sub2api account: { name, platform, type, credentials:{...} }
    const cred =
      src.credentials && typeof src.credentials === "object" ? src.credentials : null;
    // codex auth.json: { tokens:{...}, last_refresh }
    const tokens =
      src.tokens && typeof src.tokens === "object" ? src.tokens : null;

    const bag = Object.assign({}, src, tokens || {}, cred || {});

    const access =
      bag.access_token || bag.accessToken || bag.token || "";
    const idToken =
      bag.id_token || bag.idToken || access || "";
    const realRefresh =
      bag.refresh_token || bag.refreshToken || "";

    const data = {
      access_token: access,
      id_token: idToken,
      refresh_token: realRefresh,
      account_id:
        bag.account_id ||
        bag.chatgpt_account_id ||
        (src.account && src.account.id) ||
        "",
      email:
        bag.email ||
        (src.user && src.user.email) ||
        (src.account && src.account.email) ||
        "",
      plan_type: bag.plan_type || bag.planType || "",
      expired: bag.expired || bag.expires_at || bag.expires || bag.expiresAt || "",
      last_refresh: bag.last_refresh || nowIso(),
      name: src.name || bag.name || "",
      _formal_refresh: false,
      _backfilled: false,
    };

    // Backfill from JWT claims when requested / needed.
    if (backfill) {
      const claims = Object.keys(jwtPayload(idToken)).length
        ? jwtPayload(idToken)
        : jwtPayload(access);
      const auth = claims["https://api.openai.com/auth"] || {};
      const profile = claims["https://api.openai.com/profile"] || {};
      let touched = false;
      if (!data.account_id && (auth.chatgpt_account_id || auth.user_id)) {
        data.account_id = auth.chatgpt_account_id || auth.user_id;
        touched = true;
      }
      if (!data.email && (profile.email || claims.email)) {
        data.email = profile.email || claims.email;
        touched = true;
      }
      if (!data.plan_type && auth.chatgpt_plan_type) {
        data.plan_type = auth.chatgpt_plan_type;
        touched = true;
      }
      if (!data.expired && claims.exp) {
        data.expired = isoFromExp(claims.exp);
        touched = true;
      }
      data._backfilled = touched;
    }

    if (!data.refresh_token) {
      data.refresh_token = "rt_0";
      data._formal_refresh = true;
    }

    if (!data.access_token) {
      throw new Error("记录缺少 access_token / accessToken。");
    }
    return data;
  }

  // ---------- builders ----------
  function buildCPA(data) {
    return clean({
      type: "codex",
      id_token: data.id_token,
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      account_id: data.account_id,
      last_refresh: data.last_refresh,
      email: data.email,
      expired: data.expired,
    });
  }

  function buildSub2apiAccount(data) {
    const label = data.email || data.account_id || "codex-account";
    return {
      name: data.name || label,
      platform: "openai",
      type: "oauth",
      credentials: clean({
        access_token: data.access_token,
        id_token: data.id_token,
        refresh_token: data.refresh_token,
        chatgpt_account_id: data.account_id,
        email: data.email,
        plan_type: data.plan_type,
        expires_at: data.expired,
        last_refresh: data.last_refresh,
      }),
    };
  }

  function safeName(data, index) {
    let base =
      (data.email && data.email.replace(/[^\w.@-]+/g, "_")) ||
      (data.account_id && String(data.account_id).replace(/[^\w-]+/g, "_")) ||
      "account_" + (index + 1);
    return base;
  }

  // ---------- minimal ustar TAR writer (pure JS) ----------
  function tarBlock(name, content) {
    const enc = new TextEncoder();
    const dataBytes = enc.encode(content);
    const size = dataBytes.length;
    const header = new Uint8Array(512);

    const putStr = (str, off, len) => {
      const b = enc.encode(str);
      for (let i = 0; i < len; i++) header[off + i] = i < b.length ? b[i] : 0;
    };
    const putOct = (val, off, len) => {
      // (len-1) octal digits then NUL
      let s = val.toString(8);
      s = s.padStart(len - 1, "0").slice(-(len - 1));
      putStr(s, off, len - 1);
      header[off + len - 1] = 0;
    };

    putStr(name, 0, 100);
    putOct(0o644, 100, 8); // mode
    putOct(0, 108, 8); // uid
    putOct(0, 116, 8); // gid
    putOct(size, 124, 12); // size
    putOct(Math.floor(Date.now() / 1000), 136, 12); // mtime
    header[156] = 0x30; // typeflag '0' = regular file
    putStr("ustar", 257, 6);
    header[263] = 0x30; // version '0'
    header[264] = 0x30; // version '0'

    // checksum: init field with spaces, sum, then write 6 octal + NUL + space
    for (let i = 148; i < 156; i++) header[i] = 0x20;
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += header[i];
    const cs = sum.toString(8).padStart(6, "0").slice(-6);
    putStr(cs, 148, 6);
    header[154] = 0;
    header[155] = 0x20;

    const padded = new Uint8Array(Math.ceil(size / 512) * 512);
    padded.set(dataBytes);

    const block = new Uint8Array(512 + padded.length);
    block.set(header, 0);
    block.set(padded, 512);
    return block;
  }

  function buildTar(files) {
    const blocks = files.map((f) => tarBlock(f.name, f.content));
    let total = 0;
    for (const b of blocks) total += b.length;
    total += 1024; // two zero blocks terminate the archive
    const out = new Uint8Array(total);
    let off = 0;
    for (const b of blocks) {
      out.set(b, off);
      off += b.length;
    }
    return out;
  }

  // ---------- pipeline ----------
  function convert() {
    lastText = "";
    lastFilename = "";
    lastIsTar = false;
    lastTarBytes = null;

    let records;
    try {
      records = parseRecords(inputEl.value);
    } catch (e) {
      setStatus("错误：" + e.message, "err");
      finish(false);
      return null;
    }

    if (!records.length) {
      setStatus("没有识别到任何记录。", "warn");
      finish(false);
      return null;
    }

    const backfill = $("backfill").checked;
    const mode = selectedMode();
    const accounts = [];
    const errors = [];
    let claimsCount = 0;
    let noRefresh = 0;

    records.forEach((rec, i) => {
      try {
        const data = normalize(rec, backfill);
        if (data._backfilled) claimsCount++;
        if (data._formal_refresh) noRefresh++;
        accounts.push(data);
      } catch (e) {
        errors.push("第 " + (i + 1) + " 条：" + e.message);
      }
    });

    $("statRecords").textContent = String(records.length);
    $("statClaims").textContent = String(claimsCount);
    $("statNoRefresh").textContent = String(noRefresh);

    if (!accounts.length) {
      setStatus("全部记录转换失败：\n" + errors.join("\n"), "err");
      finish(false);
      return null;
    }

    if (mode === "sub2api") {
      const bundle = accounts.map(buildSub2apiAccount);
      lastText = JSON.stringify(bundle, null, 2) + "\n";
      lastFilename = "sub2api.json";
      lastIsTar = false;
      outputEl.value = lastText;
      $("outNote").textContent =
        "sub2api bundle：一个数组，含 " + bundle.length + " 个账号，可直接批量导入。";
    } else {
      // CPA
      if (accounts.length === 1) {
        lastText = JSON.stringify(buildCPA(accounts[0]), null, 2) + "\n";
        lastFilename = "auth.json";
        lastIsTar = false;
        outputEl.value = lastText;
        $("outNote").textContent = "单账号：下载为一个 CPA JSON 文件。";
      } else {
        const files = accounts.map((d, i) => ({
          name: safeName(d, i) + ".json",
          content: JSON.stringify(buildCPA(d), null, 2) + "\n",
        }));
        // preview = all CPA objects in an array (read-only view)
        lastText =
          JSON.stringify(accounts.map(buildCPA), null, 2) + "\n";
        lastTarBytes = buildTar(files);
        lastFilename = "cpa_accounts.tar";
        lastIsTar = true;
        outputEl.value =
          "// 预览：共 " +
          files.length +
          " 个账号，下载为 .tar（包内每个账号一个 JSON）\n" +
          lastText;
        $("outNote").textContent =
          "多账号 CPA：下载 .tar，包内 " + files.length + " 个 JSON 文件。";
      }
    }

    const msgs = [];
    msgs.push("完成：成功 " + accounts.length + " / " + records.length + " 条。");
    if (claimsCount) msgs.push("回填 claims " + claimsCount + " 条。");
    if (noRefresh) msgs.push("其中 " + noRefresh + " 条无真实 refresh_token，写入占位 rt_0。");
    if (errors.length) msgs.push("失败 " + errors.length + " 条：\n" + errors.join("\n"));
    setStatus(msgs.join(" "), errors.length ? "warn" : "ok");

    finish(true);
    return accounts;
  }

  function finish(ok) {
    $("copy").disabled = !ok;
    $("download").disabled = !ok;
  }

  // ---------- detect (identify only, no conversion) ----------
  function detect() {
    let records;
    try {
      records = parseRecords(inputEl.value);
    } catch (e) {
      setStatus("错误：" + e.message, "err");
      $("statRecords").textContent = "0";
      return;
    }
    $("statRecords").textContent = String(records.length);
    $("statClaims").textContent = "0";
    $("statNoRefresh").textContent = "0";
    if (!records.length) {
      setStatus("没有识别到记录。", "warn");
      return;
    }
    // quick shape hints
    const sample = records[0] || {};
    const hints = [];
    if (sample.credentials) hints.push("sub2api 账号");
    if (sample.tokens) hints.push("Codex auth.json");
    if (sample.type === "codex") hints.push("CPA");
    if (sample.accessToken || sample.user || sample.account) hints.push("ChatGPT session");
    setStatus(
      "识别到 " +
        records.length +
        " 条记录" +
        (hints.length ? "（疑似：" + hints.join(" / ") + "）" : "") +
        "。点“转换”生成结果。",
      "ok"
    );
  }

  // ---------- downloads ----------
  function download() {
    let blob;
    if (lastIsTar && lastTarBytes) {
      blob = new Blob([lastTarBytes], { type: "application/x-tar" });
    } else {
      blob = new Blob([lastText], { type: "application/json" });
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = lastFilename || "output.json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(lastText);
      setStatus("已复制到剪贴板。" + (lastIsTar ? "（.tar 请用“下载”获取）" : ""), "ok");
    } catch (_) {
      setStatus("复制失败，请手动选择输出框内容。", "warn");
    }
  }

  // ---------- sample ----------
  const SAMPLE = JSON.stringify(
    {
      user: { email: "demo@example.com" },
      account: { id: "acc_demo_123" },
      accessToken: "eyJhbGciOiJERUZBVUxUIn0.eyJodHRwczovL2FwaS5vcGVuYWkuY29tL2F1dGgiOnsiY2hhdGdwdF9hY2NvdW50X2lkIjoiYWNjX2RlbW9fMTIzIn0sImV4cCI6NDg2NTQ5MTIwMH0.sig",
      expires: "2099-01-01T00:00:00Z",
    },
    null,
    2
  );

  // ---------- wiring ----------
  $("convert").addEventListener("click", convert);
  $("detect").addEventListener("click", detect);
  $("copy").addEventListener("click", copy);
  $("download").addEventListener("click", download);
  $("sample").addEventListener("click", () => {
    inputEl.value = SAMPLE;
    detect();
  });
  $("clear").addEventListener("click", () => {
    inputEl.value = "";
    outputEl.value = "";
    lastText = "";
    lastTarBytes = null;
    $("statRecords").textContent = "0";
    $("statClaims").textContent = "0";
    $("statNoRefresh").textContent = "0";
    finish(false);
    setStatus("等待输入。");
  });
  document.querySelectorAll('input[name="mode"]').forEach((el) =>
    el.addEventListener("change", () => {
      if (inputEl.value.trim()) convert();
    })
  );
  $("file").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const parts = [];
    for (const f of files) parts.push(await f.text());
    // join with newlines so multiple files become JSONL-friendly
    inputEl.value = parts.join("\n");
    detect();
    e.target.value = "";
  });
})();
