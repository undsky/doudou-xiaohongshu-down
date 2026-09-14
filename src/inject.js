(function() {
  if (window.__doudouXhsInjected) return;
  window.__doudouXhsInjected = true;

  // ===== 为什么必须在 Main World 被动截获 =====
  // 小红书所有 /api/sns/web/** 接口都校验 x-s / x-t 签名头，签名算法在页面
  // 自身的混淆 JS 里。插件自行构造请求一律返回 406（已实测），所以唯一可行
  // 的路子是被动截获页面自己发出的、已经带好签名的响应。
  //
  // 数据有两条来源，缺一不可：
  //   1. 直接打开笔记链接 → 服务端渲染，数据只在 window.__INITIAL_STATE__ 里，
  //      整个过程不发任何笔记接口请求；
  //   2. 站内点击跳转（SPA）→ 走 POST /api/sns/web/v1/feed。
  // 只做接口拦截会漏掉第 1 种，只读 INITIAL_STATE 会漏掉第 2 种。

  // 同一份数据在两条来源里的字段命名不一致：
  // INITIAL_STATE 是驼峰（imageList / fileId / urlDefault），
  // 接口响应是下划线（image_list / file_id / url_default）。此处统一兼容。
  function pick(obj, camel, snake) {
    if (!obj) return undefined;
    return obj[camel] !== undefined ? obj[camel] : obj[snake];
  }

  // 从单张图片对象中取出 fileId —— 这是拿到无水印原图的唯一钥匙。
  // urlDefault / urlPre 都指向签名 CDN 的降质带水印版本，一律不用。
  function extractImageFileId(img) {
    if (!img) return null;
    if (typeof img === 'string') return null;

    const fileId = pick(img, 'fileId', 'file_id');
    if (fileId && typeof fileId === 'string' && fileId.length > 0) {
      return fileId;
    }

    // 兜底：个别历史数据没有 fileId 字段，只能从签名直链里反解。
    // 直链形如 .../<traceTs>/<hash>/<fileId>!<处理指令>，
    // fileId 是 ! 之前、紧跟 hash 段之后的部分（可能自带 notes_pre_post/ 前缀）。
    const url = pick(img, 'urlDefault', 'url_default') || pick(img, 'urlPre', 'url_pre') || img.url;
    if (url && typeof url === 'string') {
      const m = url.match(/xhscdn\.com\/\d+\/[0-9a-f]+\/(.+?)(?:!|$)/);
      if (m && m[1]) return m[1];
    }
    return null;
  }

  function collectImages(note) {
    const list = pick(note, 'imageList', 'image_list');
    if (!Array.isArray(list) || list.length === 0) return null;

    const out = [];
    list.forEach((img) => {
      const fileId = extractImageFileId(img);
      if (!fileId) return;
      out.push({
        fileId: fileId,
        width: img.width || 0,
        height: img.height || 0,
        livePhoto: !!pick(img, 'livePhoto', 'live_photo')
      });
    });
    return out.length > 0 ? out : null;
  }

  // 视频码流择优。
  // 小红书按编码把同一条视频分桶：EF4(H.264) / EF5(H.265) / EF6 / EF7，
  // 每桶内还有多组分辨率与码率，且 defaultStream 标记并不指向最优的一路。
  // 实测同一条 1080x1920 会同时存在 videoBitrate 296810 与 229839 两个版本，
  // 只看分辨率会随机拿到码率更低的那个，所以必须按分辨率→码率→体积三级择优。
  function collectVideo(note) {
    const video = note.video;
    if (!video) return null;

    const media = video.media;
    const stream = media && media.stream;
    if (!stream) return null;

    const all = [];
    Object.keys(stream).forEach((codecKey) => {
      const arr = stream[codecKey];
      if (!Array.isArray(arr)) return;
      arr.forEach((s) => {
        const master = pick(s, 'masterUrl', 'master_url');
        const backups = pick(s, 'backupUrls', 'backup_urls') || [];
        if (!master && backups.length === 0) return;
        all.push({
          codec: codecKey,
          width: s.width || 0,
          height: s.height || 0,
          size: s.size || 0,
          videoBitrate: pick(s, 'videoBitrate', 'video_bitrate') || 0,
          avgBitrate: pick(s, 'avgBitrate', 'avg_bitrate') || 0,
          format: s.format || 'mp4',
          masterUrl: master || null,
          backupUrls: Array.isArray(backups) ? backups : []
        });
      });
    });

    if (all.length === 0) return null;

    // 打分与 WASM 侧 scoreVideoStreamWasm 保持同一套权重
    all.sort((a, b) => {
      const pa = a.width * a.height, pb = b.width * b.height;
      if (pa !== pb) return pb - pa;
      if (a.videoBitrate !== b.videoBitrate) return b.videoBitrate - a.videoBitrate;
      return b.size - a.size;
    });

    return { best: all[0], count: all.length };
  }

  function parseNote(note, images, videos) {
    if (!note || typeof note !== 'object') return;
    const id = pick(note, 'noteId', 'note_id') || note.id;
    if (!id) return;

    const type = note.type;

    // 视频笔记的 imageList 里装的是封面图，不是可下载的图集内容。
    // 按 type 严格分流，否则会把视频笔记误报成 1 张图的图文笔记。
    if (type === 'video') {
      const v = collectVideo(note);
      if (v) {
        videos[id] = {
          title: note.title || note.desc || '',
          stream: v.best,
          streamCount: v.count
        };
      }
      return;
    }

    const imgs = collectImages(note);
    if (imgs) {
      images[id] = { title: note.title || note.desc || '', images: imgs };
    }
  }

  function collectFromPayload(data, images, videos) {
    if (!data || typeof data !== 'object') return;

    // /api/sns/web/v1/feed → data.items[].note_card
    const items = data.data?.items || data.items;
    if (Array.isArray(items)) {
      items.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const nc = pick(item, 'noteCard', 'note_card');
        if (nc) {
          // 接口的 note_card 不带 note_id，ID 在外层 item 上
          if (!pick(nc, 'noteId', 'note_id') && item.id) nc.note_id = item.id;
          parseNote(nc, images, videos);
        }
        if (item.note) parseNote(item.note, images, videos);
      });
    }

    // 部分接口直接给 note_list / notes
    const lists = [data.data?.notes, data.notes, data.data?.note_list, data.note_list];
    lists.forEach((l) => {
      if (Array.isArray(l)) l.forEach((n) => parseNote(pick(n, 'noteCard', 'note_card') || n, images, videos));
    });
  }

  function processResponseText(text) {
    if (!text || text.length < 2) return;
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      return;
    }

    const images = {};
    const videos = {};
    collectFromPayload(data, images, videos);
    emit(images, videos);
  }

  function emit(images, videos) {
    if (Object.keys(images).length > 0 || Object.keys(videos).length > 0) {
      window.postMessage({ type: 'DOUDOU_XHS_MEDIA_DATA', images, videos }, '*');
    }
  }

  // ===== 来源 1：服务端渲染的 __INITIAL_STATE__ =====
  // 直接打开 /explore/<id> 时数据只在这里。noteDetailMap 的键里会掺一个
  // 字面量 "undefined"（小红书自身的占位），必须跳过。
  function harvestInitialState() {
    const state = window.__INITIAL_STATE__;
    if (!state) return false;

    const images = {};
    const videos = {};

    const map = state.note?.noteDetailMap;
    if (map) {
      Object.keys(map).forEach((id) => {
        if (id === 'undefined') return;
        const note = map[id]?.note;
        if (note) {
          if (!pick(note, 'noteId', 'note_id')) note.noteId = id;
          parseNote(note, images, videos);
        }
      });
    }

    // 信息流卡片只有封面，没有完整图集，仅用于补充标题，不作为资源来源。
    const found = Object.keys(images).length > 0 || Object.keys(videos).length > 0;
    if (found) emit(images, videos);
    return found;
  }

  // __INITIAL_STATE__ 是页面脚本执行后才挂上的，document_start 时机必然读不到；
  // 且 SPA 切换笔记时小红书会就地改写 noteDetailMap，所以需要持续复查。
  let stateTries = 0;
  const stateTimer = setInterval(() => {
    stateTries++;
    harvestInitialState();
    if (stateTries > 40) clearInterval(stateTimer);
  }, 250);

  // ===== 来源 2：拦截页面自己发出的已签名接口请求 =====
  function isTargetApi(urlString) {
    if (!urlString) return false;
    return urlString.includes('/api/sns/web/v1/feed') ||
           urlString.includes('/api/sns/web/v1/homefeed') ||
           urlString.includes('/api/sns/web/v1/search/notes') ||
           urlString.includes('/api/sns/web/v1/user_posted') ||
           urlString.includes('/api/sns/web/v2/note/collect/page') ||
           urlString.includes('/api/sns/web/v1/note/');
  }

  const originalFetch = window.fetch;
  window.fetch = function(url, options) {
    const urlString = typeof url === 'string' ? url : (url && url.url) || '';
    const promise = originalFetch.apply(this, arguments);

    if (isTargetApi(urlString)) {
      promise.then((response) => {
        response.clone().text().then(processResponseText).catch(() => {});
      }).catch(() => {});
    }
    return promise;
  };

  const XHR = XMLHttpRequest.prototype;
  const originalOpen = XHR.open;
  const originalSend = XHR.send;

  XHR.open = function(method, url) {
    this.__doudouUrl = url;
    return originalOpen.apply(this, arguments);
  };

  XHR.send = function() {
    this.addEventListener('load', function() {
      const u = this.__doudouUrl;
      const urlString = typeof u === 'string' ? u : (u && u.url) || '';
      if (isTargetApi(urlString)) {
        try {
          processResponseText(this.responseText);
        } catch (e) {}
      }
    });
    return originalSend.apply(this, arguments);
  };

  // ===== SPA 路由变化通知 =====
  // 小红书在信息流里点开笔记只改写 history（/explore/<id>?xsec_token=...），
  // 不刷新页面也不触发 popstate；内容脚本运行在隔离世界拿不到页面的 history，
  // 只能在 Main World hook 后 postMessage 通知对面重新扫描。
  let lastHref = location.href;
  function notifyUrlChange() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    window.postMessage({ type: 'DOUDOU_XHS_URL_CHANGED', url: location.href }, '*');
    // 路由变了，INITIAL_STATE 往往随后被就地改写，重启一轮复查
    stateTries = 0;
  }

  ['pushState', 'replaceState'].forEach(function(name) {
    const orig = history[name];
    if (typeof orig !== 'function') return;
    history[name] = function() {
      const ret = orig.apply(this, arguments);
      setTimeout(notifyUrlChange, 0);
      return ret;
    };
  });
  window.addEventListener('popstate', () => setTimeout(notifyUrlChange, 0));
  window.addEventListener('hashchange', () => setTimeout(notifyUrlChange, 0));
  setInterval(notifyUrlChange, 500);
})();
