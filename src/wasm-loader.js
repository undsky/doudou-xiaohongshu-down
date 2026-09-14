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
