/* Xiaohongshu WASM Loader Bundle */
/**
 * 小红书下载助手 - WASM 加载器与算法桥接
 */
(function (global) {
  "use strict";

  let wasmInstance = null;
  let wasmLoadingPromise = null;

  async function initWasm() {
    if (wasmInstance) return wasmInstance;
    if (wasmLoadingPromise) return wasmLoadingPromise;

    wasmLoadingPromise = (async () => {
      try {
        let wasmUrl = "build/xiaohongshu.wasm";
        if (typeof chrome !== "undefined" && chrome.runtime?.getURL) {
          wasmUrl = chrome.runtime.getURL("build/xiaohongshu.wasm");
        }

        const response = await fetch(wasmUrl);
        const bytes = await response.arrayBuffer();

        const module = await WebAssembly.instantiate(bytes, {
          env: {
            abort(msg, file, line, col) {
              console.error("[小红书 WASM] Abort called:", { msg, file, line, col });
            }
          }
        });

        wasmInstance = module.instance;
        console.log("[小红书 WASM] 核心 WebAssembly 算法模块成功装载并在沙箱中就绪");
        return wasmInstance;
      } catch (err) {
        console.error("[小红书 WASM] 加载 WASM 核心模块失败:", err);
        throw err;
      }
    })();

    return wasmLoadingPromise;
  }

  // 内存辅助读写机制
  function writeStringToMemory(instance, str, ptr) {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(str || "");
    const memView = new Uint8Array(instance.exports.memory.buffer);
    memView.set(bytes, ptr);
    return bytes.length;
  }

  function readStringFromMemory(instance, ptr, len) {
    if (!len || len <= 0) return "";
    const memView = new Uint8Array(instance.exports.memory.buffer, ptr, len);
    return new TextDecoder("utf-8").decode(memView);
  }

  function ptrs(instance) {
    const { getInBufPtr, getOutBufPtr } = instance.exports;
    const inPtr = getInBufPtr ? getInBufPtr() : 1024;
    const outPtr = getOutBufPtr ? getOutBufPtr() : inPtr + 4096;
    return { inPtr, outPtr };
  }

  async function isTargetApi(url) {
    if (!url) return false;
    const instance = await initWasm();
    const { inPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, url, inPtr);
    return instance.exports.isTargetApiWasm(inPtr, inLen) === 1;
  }

  async function extractNoteId(url) {
    if (!url) return "";
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, url, inPtr);
    const outLen = instance.exports.extractNoteIdWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  // 核心：fileId → 无水印原图直链
  async function buildOriginalImageUrl(fileId, fmt) {
    if (!fileId) return "";
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const idLen = writeStringToMemory(instance, fileId, inPtr);
    const fmtPtr = inPtr + idLen + 16;
    const fmtLen = writeStringToMemory(instance, fmt || "", fmtPtr);
    const outLen = instance.exports.buildOriginalImageUrlWasm(
      inPtr, idLen, fmtPtr, fmtLen, outPtr
    );
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function shouldTranscode(mime) {
    const instance = await initWasm();
    const { inPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, mime || "", inPtr);
    return instance.exports.shouldTranscodeWasm(inPtr, inLen) === 1;
  }

  async function extFromMime(mime) {
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, mime || "", inPtr);
    const outLen = instance.exports.extFromMimeWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  // 核心：视频码流画质打分（返回 BigInt，调用方直接比较）
  async function scoreVideoStream(width, height, videoBitrate, size) {
    const instance = await initWasm();
    return instance.exports.scoreVideoStreamWasm(
      width | 0, height | 0, videoBitrate | 0, size | 0
    );
  }

  async function cleanVideoUrl(url) {
    if (!url) return "";
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, url, inPtr);
    const outLen = instance.exports.cleanVideoUrlWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function sanitizeFilename(name) {
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const inLen = writeStringToMemory(instance, name || "", inPtr);
    const outLen = instance.exports.sanitizeFilenameWasm(inPtr, inLen, outPtr);
    return readStringFromMemory(instance, outPtr, outLen);
  }

  async function buildDownloadPath(type, timestamp, index, ext) {
    const instance = await initWasm();
    const { inPtr, outPtr } = ptrs(instance);
    const typeLen = writeStringToMemory(instance, type || "video", inPtr);
    const extPtr = inPtr + typeLen + 16;
    const extLen = writeStringToMemory(instance, ext || "", extPtr);
    const outLen = instance.exports.buildDownloadPathWasm(
      inPtr, typeLen, BigInt(timestamp || Date.now()), index || 0, extPtr, extLen, outPtr
    );
    return readStringFromMemory(instance, outPtr, outLen);
  }

  global.XhsWasm = {
    initWasm,
    isTargetApi,
    extractNoteId,
    buildOriginalImageUrl,
    shouldTranscode,
    extFromMime,
    scoreVideoStream,
    cleanVideoUrl,
    sanitizeFilename,
    buildDownloadPath
  };
})(typeof window !== "undefined" ? window : globalThis);


/* Xiaohongshu Downloader Core */
/**
 * 小红书下载助手 - Content Script
 * 驱动架构：AssemblyScript / WebAssembly (WASM) 核心算法模块
 * 功能：图文笔记无水印高清原图批量保存、视频笔记最优码流下载、资源扫描与悬浮下载面板 UI
 */

(function() {
  'use strict';

  // 创作者 / 商家后台不加载本插件
  const HOST = location.hostname;
  if (HOST === 'creator.xiaohongshu.com' || HOST === 'ark.xiaohongshu.com') return;

  if (window.xhsDownloaderInjected) return;
  window.xhsDownloaderInjected = true;

  // ==================== 立即注入 API 拦截脚本（外部文件以符合 CSP）====================
  const injectScript = document.createElement('script');
  injectScript.src = chrome.runtime.getURL('src/inject.js');
  (document.head || document.documentElement).appendChild(injectScript);

  // ==================== 全局数据存储 ====================

  // noteId -> { title, images: [{fileId,width,height,livePhoto}] }
  window.__xhsImageData = window.__xhsImageData || {};
  // noteId -> { title, stream: {...}, streamCount }
  window.__xhsVideoData = window.__xhsVideoData || {};

  const resourceMap = new Map();
  let panelEl = null;
  let ballEl = null;
  let isDownloadingAll = false;
  const downloadingResources = new Set();
  let hasUpdate = false;
  let updateUrl = 'https://gitee.com/undsky/doudou-xiaohongshu-down';

  // ==================== WASM 算法桥接封装 ====================

  async function buildOriginalImageUrl(fileId, fmt) {
    await XhsWasm.initWasm();
    return await XhsWasm.buildOriginalImageUrl(fileId, fmt);
  }

  async function shouldTranscode(mime) {
    await XhsWasm.initWasm();
    return await XhsWasm.shouldTranscode(mime);
  }

  async function extFromMime(mime) {
    await XhsWasm.initWasm();
    return await XhsWasm.extFromMime(mime);
  }

  async function cleanVideoUrl(url) {
    await XhsWasm.initWasm();
    return await XhsWasm.cleanVideoUrl(url);
  }

  async function sanitizeFilename(name) {
    await XhsWasm.initWasm();
    return await XhsWasm.sanitizeFilename(name);
  }

  async function buildDownloadPath(type, timestamp, index = 0, ext = '') {
    await XhsWasm.initWasm();
    return await XhsWasm.buildDownloadPath(type, timestamp, index, ext);
  }

  async function getCurrentNoteId() {
    await XhsWasm.initWasm();
    const fromUrl = await XhsWasm.extractNoteId(location.href);
    return fromUrl || null;
  }

  // ==================== UI 工具函数 ====================

  function appendToBody(element) {
    if (!element) return;
    const parent = document.body || document.documentElement;
    if (parent) {
      parent.appendChild(element);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        (document.body || document.documentElement).appendChild(element);
      }, { once: true });
    }
  }

  function showToast(message, duration = 3000) {
    const existing = document.querySelector('.xhs-downloader-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'xhs-downloader-toast';
    toast.textContent = message;
    appendToBody(toast);
    setTimeout(() => toast.remove(), duration);
  }

  function setButtonState(btn, state) {
    if (!btn) return;
    btn.classList.remove('loading', 'success', 'error');
    if (state) btn.classList.add(state);
    setTimeout(() => btn.classList.remove('success', 'error'), 2000);
  }

  function createProgress(title) {
    const existing = document.querySelector('.xhs-downloader-progress');
    if (existing) existing.remove();

    const progress = document.createElement('div');
    progress.className = 'xhs-downloader-progress';
    progress.innerHTML = `
      <div class="xhs-downloader-progress-title"></div>
      <div class="xhs-downloader-progress-bar">
        <div class="xhs-downloader-progress-fill" style="width: 0%"></div>
      </div>
      <div class="xhs-downloader-progress-text">准备中...</div>
    `;
    progress.querySelector('.xhs-downloader-progress-title').textContent = title;
    appendToBody(progress);
    return {
      update: (current, total, text = '') => {
        const percent = total > 0 ? Math.round((current / total) * 100) : 0;
        progress.querySelector('.xhs-downloader-progress-fill').style.width = `${percent}%`;
        progress.querySelector('.xhs-downloader-progress-text').textContent = text || `${current} / ${total}`;
      },
      close: () => setTimeout(() => progress.remove(), 500)
    };
  }

  // ==================== 保存管线 ====================

  function saveBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = objectUrl;
    a.download = filename.replace(/\//g, '_');
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 3000);
  }

  // 单张原图保存。
  //
  // 策略分两步，目的是"既拿到原始画质，又保证文件能打开"：
  //   1. 先请求服务端存储的原始字节（不带任何处理参数）。若它本就是 Web 通用
  //      格式（jpg/png/webp/gif），直接落盘 —— 零重编码、零画质损失、体积最小。
  //   2. 小红书大量笔记的存储原件是 HEIC：画质与体积都最优，但 Windows 和多数
  //      浏览器打不开。这种情况才请求服务端转码。转 PNG 而非 JPEG，是因为源已
  //      经是有损编码，再压一次 JPEG 是二次有损；PNG 无损容器只增体积不掉画质。
  //
  // 实测同一张 2882x2161：原始 JPEG 977KB，强制转 PNG 4578KB —— 所以能直存时
  // 绝不转码，这一步不只是省流量，更是避免无意义的体积膨胀。
  async function downloadImageFile(fileId, index, timestamp) {
    // 第一步：取原始字节
    const originUrl = await buildOriginalImageUrl(fileId, '');
    try {
      const response = await fetch(originUrl, { mode: 'cors', credentials: 'omit' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const mime = response.headers.get('content-type') || '';
      const needTranscode = await shouldTranscode(mime);

      if (!needTranscode) {
        const blob = await response.blob();
        if (blob.size < 500) throw new Error('响应数据过小，疑似异常');
        const ext = await extFromMime(mime);
        const filename = await buildDownloadPath('image', timestamp, index, ext);
        saveBlob(blob, filename);
        return { success: true, bytes: blob.size, transcoded: false, ext };
      }

      // 第二步：异种格式（HEIC/AVIF 等）→ 请求服务端无损转 PNG
      const pngUrl = await buildOriginalImageUrl(fileId, 'png');
      const pngResp = await fetch(pngUrl, { mode: 'cors', credentials: 'omit' });
      if (!pngResp.ok) throw new Error(`转码请求失败 HTTP ${pngResp.status}`);

      const pngBlob = await pngResp.blob();
      if (pngBlob.size < 500) throw new Error('转码响应数据过小');
      const filename = await buildDownloadPath('image', timestamp, index, 'png');
      saveBlob(pngBlob, filename);
      return { success: true, bytes: pngBlob.size, transcoded: true, ext: 'png' };
    } catch (error) {
      console.warn('[豆豆] 原图下载失败:', fileId, error);
      return { success: false, error: error.message };
    }
  }

  // 视频保存。
  // masterUrl 带 sign 与 t 参数、会过期；backupUrls 实测不校验签名，是长效兜底。
  // 两者都试一遍，任一成功即止；全部失败再交给 background 的 downloads API
  // （它不受页面 CORS 约束，能兜住防盗链场景）。
  async function downloadVideoFile(stream, timestamp) {
    const candidates = [];
    if (stream.masterUrl) candidates.push(await cleanVideoUrl(stream.masterUrl));
    for (const b of stream.backupUrls || []) {
      candidates.push(await cleanVideoUrl(b));
    }

    const ext = stream.format || 'mp4';
    const filename = await buildDownloadPath('video', timestamp, 0, ext);

    for (const url of candidates) {
      try {
        showToast('正在缓冲视频到内存，请稍候...', 12000);
        const response = await fetch(url, { credentials: 'omit' });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const blob = await response.blob();
        // 防盗链拦截时服务端会回 HTML 而非视频流
        if (blob.type.includes('text/html') || blob.size < 1000) {
          throw new Error('被防盗链拦截');
        }

        showToast('缓冲完成，正在保存文件...', 3000);
        saveBlob(blob, filename);
        return { success: true, bytes: blob.size };
      } catch (error) {
        console.warn('[豆豆] 视频直链下载失败，尝试下一条:', url.slice(0, 80), error.message);
      }
    }

    // 全部直链失败 → 交给后台服务
    showToast('页面内下载失败，转后台服务下载...', 2000);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({
        type: 'DOUDOU_DOWNLOAD_MEDIA',
        url: candidates[0],
        filename: filename
      }, (response) => {
        void chrome.runtime.lastError;
        resolve(response || { success: false, error: '后台下载无响应' });
      });
    });
  }

  // ==================== 资源扫描 ====================

  // DOM 兜底：仅在接口与 SSR 数据都缺失时启用。
  //
  // 不能全页扫图：信息流 / 搜索页的结果列表里全是其它笔记的封面，URL 特征与
  // 当前笔记的图完全一致，弹层打开时它们仍在 DOM 中，会把视频笔记误判成图文。
  // 所以先锚定"主视区里最大的一张笔记图"—— 弹层里的当前图必然显著大于背景
  // 列表封面 —— 再只从它所在容器内、按同等尺寸量级取图。
  function looksLikeNoteImage(url) {
    if (!url || typeof url !== 'string') return false;
    if (!url.includes('xhscdn.com')) return false;
    // 排除头像、表情、站点装饰
    if (/sns-avatar|\/avatar\/|fe-platform|picasso-static|redmoji|emoji/i.test(url)) return false;
    return /notes_pre_post|\/spectrum\/|sns-webpic|sns-img/i.test(url);
  }

  function extractFileIdFromUrl(url) {
    if (!url) return null;
    const m = url.match(/xhscdn\.com\/\d+\/[0-9a-f]+\/(.+?)(?:!|\?|$)/);
    if (m && m[1]) return m[1];
    const m2 = url.match(/xhscdn\.com\/((?:notes_pre_post\/|spectrum\/)?[A-Za-z0-9_]+)(?:!|\?|$)/);
    return m2 && m2[1] ? m2[1] : null;
  }

  function extractImagesFromDOM() {
    const vw = window.innerWidth || document.documentElement.clientWidth || 0;
    const vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return [];

    const normalize = (src) => (src && src.startsWith('//') ? 'https:' + src : src);

    let anchor = null;
    let anchorArea = 0;
    document.querySelectorAll('img[src]').forEach((img) => {
      if (!looksLikeNoteImage(normalize(img.getAttribute('src')))) return;
      const r = img.getBoundingClientRect();
      if (r.width < 200 || r.height < 200) return;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cx > vw || cy < 0 || cy > vh) return;
      const area = r.width * r.height;
      if (area > anchorArea) { anchorArea = area; anchor = img; }
    });

    // 达不到主视区大图体量（视口面积 8%）的，只可能是列表封面
    if (!anchor || anchorArea < vw * vh * 0.08) return [];

    const container =
      anchor.closest('.swiper-wrapper, [class*="swiper"], [class*="media-container"], [class*="note-slider"]') ||
      anchor.parentElement;

    const out = [];
    const seen = new Set();
    const push = (src) => {
      src = normalize(src);
      if (!src || !looksLikeNoteImage(src)) return;
      const fileId = extractFileIdFromUrl(src);
      if (!fileId || seen.has(fileId)) return;
      seen.add(fileId);
      out.push({ fileId, width: 0, height: 0, livePhoto: false });
    };

    if (container) {
      container.querySelectorAll('img[src]').forEach((img) => {
        const r = img.getBoundingClientRect();
        // 同组其它张（含滑出可视区的相邻 slide）尺寸与锚点同量级
        if (r.width * r.height >= anchorArea * 0.4) push(img.getAttribute('src'));
      });
    }
    if (out.length === 0) push(anchor.getAttribute('src'));
    return out;
  }

  async function scanResources() {
    const noteId = await getCurrentNoteId();
    resourceMap.clear();

    const imgEntry = noteId ? window.__xhsImageData[noteId] : null;
    const vidEntry = noteId ? window.__xhsVideoData[noteId] : null;

    console.log('[豆豆] 扫描资源, noteId:', noteId,
      '| 图文缓存:', imgEntry ? imgEntry.images.length + ' 张' : '无',
      '| 视频缓存:', vidEntry ? '有' : '无');

    if (imgEntry && imgEntry.images.length > 0) {
      resourceMap.set(`image_${noteId}`, {
        id: noteId,
        type: 'image',
        title: imgEntry.title || '小红书图文笔记',
        images: imgEntry.images,
        count: imgEntry.images.length
      });
    }

    if (vidEntry && vidEntry.stream) {
      const s = vidEntry.stream;
      resourceMap.set(`video_${noteId}`, {
        id: noteId,
        type: 'video',
        title: vidEntry.title || '小红书视频笔记',
        stream: s,
        quality: `${s.width}x${s.height}`,
        sizeMB: s.size ? (s.size / 1048576).toFixed(1) : null
      });
    }

    // 接口与 SSR 都没给出数据时才走 DOM 兜底。
    // 已经拿到视频数据就绝不扫图 —— 否则会把弹层背后列表里其它图文笔记的
    // 封面扫进来，把视频笔记误报成图文。
    if (resourceMap.size === 0) {
      const domImages = extractImagesFromDOM();
      if (domImages.length > 0) {
        const id = noteId || `dom_${Date.now()}`;
        resourceMap.set(`image_${id}`, {
          id,
          type: 'image',
          title: '小红书图文笔记（页面解析）',
          images: domImages,
          count: domImages.length
        });
      }
    }

    updateBallCount();
  }

  // ==================== 扫描调度（串行化 + 切换笔记后重试） ====================

  // scanResources 一进入就清空 resourceMap，若写成 `scanResources(); renderList();`
  // 渲染会发生在 await 之前，拿到的必然是刚被清空的列表。统一由这里调度：
  // 串行执行、扫完再渲染，扫描期间的新请求合并成一次补扫。
  let scanRunning = false;
  let scanPending = false;

  async function requestScan() {
    if (scanRunning) { scanPending = true; return; }
    scanRunning = true;
    const oldSize = resourceMap.size;
    try {
      do {
        scanPending = false;
        try {
          await scanResources();
        } catch (e) {
          console.warn('[豆豆] 扫描小红书资源失败:', e);
        }
        renderList();
      } while (scanPending);
    } finally {
      scanRunning = false;
      if (resourceMap.size > oldSize && isProbing) {
        stopProbe(false);
        renderList();
      }
    }
  }

  // 切换笔记后接口响应与 SSR 状态都是稍后才到达的，单次扫描大概率扑空。
  // 按递增延时重试，一旦扫到资源立即停止。
  const PROBE_DELAYS = [400, 900, 1500, 2500, 4000, 6000, 9000, 12000];
  let probeTimers = [];
  let isProbing = false;

  function stopProbe(render = false) {
    probeTimers.forEach(clearTimeout);
    probeTimers = [];
    isProbing = false;
    if (render) renderList();
  }

  function probeResources({ delays = PROBE_DELAYS, toastOnFail = false } = {}) {
    stopProbe();
    isProbing = true;
    renderList();

    delays.forEach((delay, i) => {
      probeTimers.push(setTimeout(async () => {
        if (resourceMap.size > 0) { stopProbe(true); return; }
        await requestScan();
        if (resourceMap.size > 0) {
          stopProbe(true);
        } else if (i === delays.length - 1) {
          stopProbe(true);
          if (toastOnFail) showToast('未发现资源，请打开笔记详情页后重试', 3000);
        }
      }, delay));
    });
  }

  let lastSeenUrl = location.href;
  function handleUrlChange() {
    if (location.href === lastSeenUrl) return;
    lastSeenUrl = location.href;

    resourceMap.clear();
    renderList();
    probeResources();
  }

  // ==================== 面板与悬浮球 UI ====================

  function renderList() {
    if (!panelEl) return;
    const listEl = panelEl.querySelector('.xhs-downloader-list');
    const countEl = panelEl.querySelector('.xhs-downloader-count');
    if (!listEl) return;

    listEl.innerHTML = '';
    if (countEl) {
      countEl.textContent = isProbing && resourceMap.size === 0
        ? '正在扫描资源...'
        : `共 ${resourceMap.size} 个资源`;
    }

    if (resourceMap.size === 0) {
      const empty = document.createElement('div');
      empty.className = 'xhs-downloader-empty';
      empty.innerHTML = isProbing
        ? '正在扫描当前笔记资源...<br><span class="xhs-downloader-empty-tip">切换笔记后需等待小红书接口返回</span>'
        : '未发现可下载资源<br><span class="xhs-downloader-empty-tip">请打开笔记详情后点击 ⟳ 重试</span>';
      listEl.appendChild(empty);
      return;
    }

    resourceMap.forEach((res) => {
      const item = document.createElement('div');
      item.className = 'xhs-downloader-item';

      const info = document.createElement('div');
      info.className = 'xhs-downloader-item-info';

      const title = document.createElement('div');
      title.className = 'xhs-downloader-item-title';
      title.textContent = res.title;

      const meta = document.createElement('div');
      meta.className = 'xhs-downloader-item-meta';

      const isImage = res.type === 'image';
      const badge = document.createElement('span');
      badge.className = `xhs-downloader-badge xhs-downloader-badge-${isImage ? 'image' : 'video'}`;
      badge.textContent = isImage ? '图文' : '视频';

      const detail = document.createElement('span');
      if (isImage) {
        const live = res.images.filter((i) => i.livePhoto).length;
        detail.textContent = `${res.count} 张无水印原图` + (live > 0 ? `（含 ${live} 张实况）` : '');
      } else {
        detail.textContent = `无水印 ${res.quality}` + (res.sizeMB ? ` · ${res.sizeMB}MB` : '');
      }

      meta.appendChild(badge);
      meta.appendChild(detail);
      info.appendChild(title);
      info.appendChild(meta);

      const btn = document.createElement('button');
      btn.className = 'xhs-downloader-btn';
      btn.textContent = '下载';

      const resourceKey = `${res.type}_${res.id}`;
      btn.addEventListener('click', () => downloadOne(res, btn, resourceKey));

      if (isDownloadingAll || downloadingResources.has(resourceKey)) {
        btn.disabled = true;
        btn.setAttribute('disabled', 'disabled');
      }

      item.appendChild(info);
      item.appendChild(btn);
      listEl.appendChild(item);
    });
  }

  function createPanel() {
    if (panelEl) return panelEl;

    panelEl = document.createElement('div');
    panelEl.className = 'xhs-downloader-panel';
    panelEl.innerHTML = `
      <div class="xhs-downloader-panel-header">
        <div>
          <div class="xhs-downloader-panel-title">资源下载</div>
          <a class="xhs-downloader-panel-subtitle" href="https://www.undsky.com" target="_blank" rel="noopener noreferrer">关于作者</a>
        </div>
        <div class="xhs-downloader-panel-actions">
          <button class="xhs-downloader-icon-btn" data-action="refresh" title="重新扫描">⟳</button>
          <button class="xhs-downloader-icon-btn" data-action="collapse" title="收起">—</button>
        </div>
      </div>
      <div class="xhs-downloader-list"></div>
      <div class="xhs-downloader-panel-footer">
        <span class="xhs-downloader-count">共 0 个资源</span>
        <button class="xhs-downloader-btn xhs-downloader-btn-send" data-action="download-all">全部下载</button>
      </div>
    `;

    panelEl.querySelector('[data-action="collapse"]')
      .addEventListener('click', () => collapsePanel());
    panelEl.querySelector('[data-action="refresh"]')
      .addEventListener('click', () => openPanel(true));
    panelEl.querySelector('[data-action="download-all"]')
      .addEventListener('click', () => downloadAll());

    renderUpdateBtn();
    appendToBody(panelEl);
    return panelEl;
  }

  function renderUpdateBtn() {
    if (!panelEl || !hasUpdate) return;
    const actionsEl = panelEl.querySelector('.xhs-downloader-panel-actions');
    if (!actionsEl) return;
    if (actionsEl.querySelector('[data-action="update"]')) return;

    const updateBtn = document.createElement('button');
    updateBtn.className = 'xhs-downloader-icon-btn';
    updateBtn.setAttribute('data-action', 'update');
    updateBtn.title = '下载最新版本';
    updateBtn.textContent = '↓';
    updateBtn.addEventListener('click', () => {
      window.open(updateUrl, '_blank', 'noopener,noreferrer');
    });

    const refreshBtn = actionsEl.querySelector('[data-action="refresh"]');
    if (refreshBtn) actionsEl.insertBefore(updateBtn, refreshBtn);
    else actionsEl.appendChild(updateBtn);
  }

  function checkVersion() {
    fetch('https://www.undsky.com/v.json')
      .then((res) => res.json())
      .then((data) => {
        const info = data && data['doudou-xiaohongshu'];
        if (!info || !info.version) return;

        const currentVersion =
          (typeof chrome !== 'undefined' &&
            chrome.runtime && chrome.runtime.getManifest &&
            chrome.runtime.getManifest().version) || '1.0.0';

        if (info.version !== currentVersion) {
          hasUpdate = true;
          if (info.url) updateUrl = info.url;
          renderUpdateBtn();
        }
      })
      .catch((err) => console.warn('[豆豆] 版本检测失败:', err));
  }

  function updateBallCount() {
    if (!ballEl) return;
    const countEl = ballEl.querySelector('.xhs-downloader-ball-count');
    if (countEl) countEl.textContent = resourceMap.size;
  }

  function showBall() {
    if (ballEl) { updateBallCount(); return; }

    ballEl = document.createElement('div');
    ballEl.className = 'xhs-downloader-ball';
    ballEl.title = '展开小红书资源下载面板';
    ballEl.innerHTML = `
      <span class="xhs-downloader-ball-icon">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="#ffffff" aria-hidden="true">
          <path d="M22.405 9.879c.002.016.01.02.07.019h.725a.797.797 0 0 0 .78-.972.794.794 0 0 0-.884-.618.795.795 0 0 0-.692.794c0 .101-.002.666.001.777zm-11.509 4.808c-.203.001-1.353.004-1.685.003a2.528 2.528 0 0 1-.766-.126.025.025 0 0 0-.03.014L7.7 16.127a.025.025 0 0 0 .01.032c.111.06.336.124.495.124.66.01 1.32.002 1.981 0 .01 0 .02-.006.023-.015l.712-1.545a.025.025 0 0 0-.024-.036zM.477 9.91c-.071 0-.076.002-.076.01a.834.834 0 0 0-.01.08c-.027.397-.038.495-.234 3.06-.012.24-.034.389-.135.607-.026.057-.033.042.003.112.046.092.681 1.523.787 1.74.008.015.011.02.017.02.008 0 .033-.026.047-.044.147-.187.268-.391.371-.606.306-.635.44-1.325.486-1.706.014-.11.021-.22.03-.33l.204-2.616.022-.293c.003-.029 0-.033-.03-.034zm7.203 3.757a1.427 1.427 0 0 1-.135-.607c-.004-.084-.031-.39-.235-3.06a.443.443 0 0 0-.01-.082c-.004-.011-.052-.008-.076-.008h-1.48c-.03.001-.034.005-.03.034l.021.293c.076.982.153 1.964.233 2.946.05.4.186 1.085.487 1.706.103.215.223.419.37.606.015.018.037.051.048.049.02-.003.742-1.642.804-1.765.036-.07.03-.055.003-.112zm3.861-.913h-.872a.126.126 0 0 1-.116-.178l1.178-2.625a.025.025 0 0 0-.023-.035l-1.318-.003a.148.148 0 0 1-.135-.21l.876-1.954a.025.025 0 0 0-.023-.035h-1.56c-.01 0-.02.006-.024.015l-.926 2.068c-.085.169-.314.634-.399.938a.534.534 0 0 0-.02.191.46.46 0 0 0 .23.378.981.981 0 0 0 .46.119h.59c.041 0-.688 1.482-.834 1.972a.53.53 0 0 0-.023.172.465.465 0 0 0 .23.398c.15.092.342.12.475.12l1.66-.001c.01 0 .02-.006.023-.015l.575-1.28a.025.025 0 0 0-.024-.035zm-6.93-4.937H3.1a.032.032 0 0 0-.034.033c0 1.048-.01 2.795-.01 6.829 0 .288-.269.262-.28.262h-.74c-.04.001-.044.004-.04.047.001.037.465 1.064.555 1.263.01.02.03.033.051.033.157.003.767.009.938-.014.153-.02.3-.06.438-.132.3-.156.49-.419.595-.765.052-.172.075-.353.075-.533.002-2.33 0-4.66-.007-6.991a.032.032 0 0 0-.032-.032zm11.784 6.896c0-.014-.01-.021-.024-.022h-1.465c-.048-.001-.049-.002-.05-.049v-4.66c0-.072-.005-.07.07-.07h.863c.08 0 .075.004.075-.074V8.393c0-.082.006-.076-.08-.076h-3.5c-.064 0-.075-.006-.075.073v1.445c0 .083-.006.077.08.077h.854c.075 0 .07-.004.07.07v4.624c0 .095.008.084-.085.084-.37 0-1.11-.002-1.304 0-.048.001-.06.03-.06.03l-.697 1.519s-.014.025-.008.036c.006.01.013.008.058.008 1.748.003 3.495.002 5.243.002.03-.001.034-.006.035-.033v-1.539zm4.177-3.43c0 .013-.007.023-.02.024-.346.006-.692.004-1.037.004-.014-.002-.022-.01-.022-.024-.005-.434-.007-.869-.01-1.303 0-.072-.006-.071.07-.07l.733-.003c.041 0 .081.002.12.015.093.025.16.107.165.204.006.431.002 1.153.001 1.153zm2.67.244a1.953 1.953 0 0 0-.883-.222h-.18c-.04-.001-.04-.003-.042-.04V10.21c0-.132-.007-.263-.025-.394a1.823 1.823 0 0 0-.153-.53 1.533 1.533 0 0 0-.677-.71 2.167 2.167 0 0 0-1-.258c-.153-.003-.567 0-.72 0-.07 0-.068.004-.068-.065V7.76c0-.031-.01-.041-.046-.039H17.93s-.016 0-.023.007c-.006.006-.008.012-.008.023v.546c-.008.036-.057.015-.082.022h-.95c-.022.002-.028.008-.03.032v1.481c0 .09-.004.082.082.082h.913c.082 0 .072.128.072.128V11.19s.003.117-.06.117h-1.482c-.068 0-.06.082-.06.082v1.445s-.01.068.064.068h1.457c.082 0 .076-.006.076.079v3.225c0 .088-.007.081.082.081h1.43c.09 0 .082.007.082-.08v-3.27c0-.029.006-.035.033-.035l2.323-.003c.098 0 .191.02.28.061a.46.46 0 0 1 .274.407c.008.395.003.79.003 1.185 0 .259-.107.367-.33.367h-1.218c-.023.002-.029.008-.028.033.184.437.374.871.57 1.303a.045.045 0 0 0 .04.026c.17.005.34.002.51.003.15-.002.517.004.666-.01a2.03 2.03 0 0 0 .408-.075c.59-.18.975-.698.976-1.313v-1.981c0-.128-.01-.254-.034-.38 0 .078-.029-.641-.724-.998z"/>
        </svg>
      </span>
      <span class="xhs-downloader-ball-count">${resourceMap.size}</span>
    `;
    ballEl.addEventListener('click', () => expandPanel());
    appendToBody(ballEl);
    updateBallCount();
  }

  function hideBall() {
    if (!ballEl) return;
    ballEl.remove();
    ballEl = null;
  }

  function collapsePanel() {
    if (panelEl) { panelEl.remove(); panelEl = null; }
    showBall();
  }

  function expandPanel() {
    hideBall();
    createPanel();
    renderList();
  }

  async function openPanel(forceScan = false) {
    expandPanel();

    if (forceScan || resourceMap.size === 0) {
      await requestScan();
      if (resourceMap.size === 0) {
        probeResources({ toastOnFail: true });
      }
    }
  }

  // ==================== 下载编排 ====================

  async function doDownloadImages(images, btn) {
    showToast(`开始下载 ${images.length} 张无水印原图...`);

    const progress = createProgress('下载图文笔记');
    const timestamp = Date.now();
    let success = 0;
    let transcoded = 0;

    for (let i = 0; i < images.length; i++) {
      progress.update(i + 1, images.length, `保存第 ${i + 1} / ${images.length} 张`);

      const result = await downloadImageFile(images[i].fileId, i + 1, timestamp);
      if (result.success) {
        success++;
        if (result.transcoded) transcoded++;
      }

      await new Promise((r) => setTimeout(r, 300));
    }

    progress.close();
    showToast(
      `成功下载 ${success}/${images.length} 张原图` +
      (transcoded > 0 ? `（${transcoded} 张 HEIC 已转为 PNG）` : ''),
      4000
    );
    setButtonState(btn, success > 0 ? 'success' : 'error');
  }

  async function doDownloadVideo(stream, btn) {
    if (!stream) {
      showToast('未找到视频码流，请重新打开笔记后重试');
      setButtonState(btn, 'error');
      return;
    }

    showToast(`开始下载 ${stream.width}x${stream.height} 无水印视频...`);
    const result = await downloadVideoFile(stream, Date.now());

    if (result && result.success) {
      const mb = result.bytes ? (result.bytes / 1048576).toFixed(1) + 'MB' : '';
      showToast(`视频下载成功！${mb}`);
      setButtonState(btn, 'success');
    } else {
      showToast('视频下载失败: ' + ((result && result.error) || '请重试'));
      setButtonState(btn, 'error');
    }
  }

  async function downloadOne(res, btn, resourceKey) {
    if (!res || !btn) return;
    if (btn.disabled || downloadingResources.has(resourceKey)) return;

    downloadingResources.add(resourceKey);
    btn.disabled = true;
    btn.setAttribute('disabled', 'disabled');
    setButtonState(btn, 'loading');

    try {
      if (res.type === 'image' && res.images && res.images.length > 0) {
        await doDownloadImages(res.images, btn);
      } else if (res.type === 'video' && res.stream) {
        await doDownloadVideo(res.stream, btn);
      } else {
        showToast('无效的资源数据');
        setButtonState(btn, 'error');
      }
    } catch (err) {
      console.error('[豆豆] 下载资源异常:', err);
      setButtonState(btn, 'error');
    } finally {
      downloadingResources.delete(resourceKey);
      // 不直接改 btn，重渲染让按钮状态与下载集合保持一致
      renderList();
    }
  }

  async function downloadAll() {
    if (isDownloadingAll) { showToast('正在批量下载中，请稍候...'); return; }
    if (resourceMap.size === 0) { showToast('无可下载资源'); return; }

    const allBtn = panelEl && panelEl.querySelector('[data-action="download-all"]');
    if (allBtn) allBtn.disabled = true;
    const itemBtns = panelEl && panelEl.querySelectorAll('.xhs-downloader-item .xhs-downloader-btn');
    if (itemBtns) itemBtns.forEach((b) => { b.disabled = true; });

    isDownloadingAll = true;
    showToast(`开始依次下载 ${resourceMap.size} 个资源...`);

    try {
      const resources = Array.from(resourceMap.values());
      for (const res of resources) {
        if (res.type === 'image' && res.images && res.images.length > 0) {
          await doDownloadImages(res.images, null);
        } else if (res.type === 'video' && res.stream) {
          await doDownloadVideo(res.stream, null);
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      showToast('所有资源下载任务完成！');
    } finally {
      isDownloadingAll = false;
      if (allBtn) allBtn.disabled = false;
      renderList();
    }
  }

  // ==================== 事件监听 ====================

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;

    if (event.data.type === 'DOUDOU_XHS_URL_CHANGED') {
      handleUrlChange();
      return;
    }

    if (event.data.type !== 'DOUDOU_XHS_MEDIA_DATA') return;

    let hasNewData = false;

    if (event.data.images) {
      for (const id in event.data.images) {
        const entry = event.data.images[id];
        if (!entry || !entry.images || entry.images.length === 0) continue;
        const old = window.__xhsImageData[id];
        // 同一笔记可能被 SSR 与接口各报一次，取图更多的那份
        if (!old || entry.images.length > old.images.length) {
          window.__xhsImageData[id] = entry;
          hasNewData = true;
        }
      }
    }

    if (event.data.videos) {
      for (const id in event.data.videos) {
        const entry = event.data.videos[id];
        if (!entry || !entry.stream) continue;
        window.__xhsVideoData[id] = entry;
        hasNewData = true;
      }
    }

    if (hasNewData) requestScan();
  });

  // ==================== 初始化 ====================

  function init() {
    if (!location.hostname.includes('xiaohongshu.com')) return;

    checkVersion();

    if (typeof XhsWasm !== 'undefined' && XhsWasm.initWasm) {
      XhsWasm.initWasm().catch((err) => {
        console.warn('[豆豆] WASM 初始化等待:', err);
      });
    }

    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'downloadXhsMediaAction') {
        openPanel(true);
        sendResponse({ success: true });
      }
      return true;
    });

    // 兜底：小红书弹层式详情在不改地址时也会换笔记，这里防抖检测
    let mutationTimer = null;
    new MutationObserver(() => {
      if (mutationTimer) return;
      mutationTimer = setTimeout(() => {
        mutationTimer = null;
        handleUrlChange();
      }, 300);
    }).observe(document.documentElement, { childList: true, subtree: true });

    const boot = () => setTimeout(() => openPanel(true), 800);
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', boot);
    } else {
      boot();
    }
  }

  init();
  console.log('[豆豆] 小红书图文/视频下载助手 (WASM 核心算法驱动) 已注入');
})();
