import Java from 'frida-java-bridge';

globalThis.Java = Java;

const MAX_HTTP_BODY = 2 * 1024 * 1024;
const MAX_HTTP_SAMPLES = 200;
const httpTasks = new Map();
// arm 阶段发现过的商品仓库实例。轮询阶段只访问这些已知实例，
// 避免在每次 RPC 中触发全堆 Java.choose 扫描。
const knownStores = [];
// 由结果页渲染回调主动喂入的"最新商品快照"，避免每次 RPC 都做 Java 反射读取 Um.g。
// 形如 { signature, products, capturedAt, storeClass, entityClass, viewClass, adapterClass }
let liveSnapshot = null;
// 缓存里是否发生过刷新（自 take_store_if_new 调用以来），用来让基线和差异比较稳定。
let liveSnapshotEpoch = 0;

function productId(product) {
  if (!product || typeof product !== 'object') return '';
  return String(product.goods_id || product.goodsId || product.goods_id_str || product.goodsIdStr || product.id || '');
}

function productSignature(products) {
  return (products || []).map(productId).filter(Boolean).join('|');
}

// 图搜业务响应是 gzip + Protobuf，不适合在网络层反解；在响应返回后从
// 已被 App 反序列化的商品仓库取快照，避免等待结果页控件渲染。

function bytesToUtf8(bytes) {
  const JString = Java.use('java.lang.String');
  return String(JString.$new(bytes, 'UTF-8'));
}

function gzipBytesToUtf8(bytes) {
  const ByteArrayInputStream = Java.use('java.io.ByteArrayInputStream');
  const ByteArrayOutputStream = Java.use('java.io.ByteArrayOutputStream');
  const GZIPInputStream = Java.use('java.util.zip.GZIPInputStream');
  const input = GZIPInputStream.$new(ByteArrayInputStream.$new(bytes));
  const output = ByteArrayOutputStream.$new();
  const chunk = Java.array('byte', new Array(8192).fill(0));
  while (true) {
    const count = input.read(chunk, 0, 8192);
    if (count <= 0) break;
    output.write(chunk, 0, count);
    if (Number(output.size()) > MAX_HTTP_BODY) throw new Error('gzip-body-too-large');
  }
  input.close();
  return bytesToUtf8(output.toByteArray());
}

function responseText(response) {
  try {
    const body = response && response.body && response.body();
    if (!body) return { text: null, error: 'missing-body' };
    const source = body.source();
    source.request(MAX_HTTP_BODY + 1);
    const buffer = source.buffer().clone();
    const size = Number(buffer.size());
    if (size <= 0) return { text: null, size, error: 'empty-body' };
    if (size > MAX_HTTP_BODY) return { text: null, size, error: 'body-too-large' };
    const bytes = buffer.readByteArray();
    const first = Number(bytes[0]) & 0xff;
    const second = Number(bytes[1]) & 0xff;
    const gzipped = first === 0x1f && second === 0x8b;
    const text = gzipped ? gzipBytesToUtf8(bytes) : bytesToUtf8(bytes);
    return { text, size, encoding: gzipped ? 'gzip' : 'plain', error: null };
  } catch (error) {
    return { text: null, error: String(error && error.message || error) };
  }
}

function responseUrl(response) {
  try {
    const request = response.request();
    return String(request.url());
  } catch {
    return null;
  }
}

function recordHttpResponse(response, hookName) {
  const capturedAt = Date.now();
  const url = responseUrl(response);
  const body = responseText(response);
  for (const task of httpTasks.values()) {
    if (capturedAt < task.armedAt) continue;
    task.seen += 1;
    if (task.samples.length < MAX_HTTP_SAMPLES) {
      task.samples.push({
        capturedAt,
        hookName,
        url,
        size: body.size || 0,
        encoding: body.encoding || null,
        error: body.error || null,
        prefix: body.text ? body.text.slice(0, 80) : null,
      });
    }
    const text = body.text;
    if (!text || (text[0] !== '{' && text[0] !== '[')) continue;
    if (task.responses.length >= 30) continue;
    task.responses.push({ capturedAt, hookName, url, body: text });
  }
}

function wrapOverloads(holder, name, wrapper) {
  const method = holder[name];
  if (!method) return false;
  method.overloads.forEach((overload) => {
    overload.implementation = function () {
      return wrapper.call(this, overload, arguments);
    };
  });
  return method.overloads.length > 0;
}

function installHttpHooks() {
  let installed = 0;
  try {
    const HttpEngine = Java.use('com.android.okhttp.internal.http.HttpEngine');
    if (wrapOverloads(HttpEngine, 'readResponse', function (overload, args) {
      const result = overload.apply(this, args);
      try { recordHttpResponse(this.getResponse(), 'HttpEngine.readResponse'); } catch {}
      return result;
    })) installed += 1;
    if (wrapOverloads(HttpEngine, 'readNetworkResponse', function (overload, args) {
      const response = overload.apply(this, args);
      recordHttpResponse(response, 'HttpEngine.readNetworkResponse');
      return response;
    })) installed += 1;
  } catch {}

  // 同一响应会经过多个阶段；这里覆盖网络层、缓存层和最终调用链，
  // 用于兼容 Temu 可能因版本、缓存或重试而走不同的 OkHttp 通路。
  const candidates = [
    ['okhttp3.internal.http.CallServerInterceptor', 'intercept'],
    ['okhttp3.internal.http.BridgeInterceptor', 'intercept'],
    ['okhttp3.internal.http.RetryAndFollowUpInterceptor', 'intercept'],
    ['okhttp3.internal.cache.CacheInterceptor', 'intercept'],
    ['okhttp3.internal.connection.ConnectInterceptor', 'intercept'],
    ['okhttp3.RealCall', 'getResponseWithInterceptorChain'],
  ];
  candidates.forEach(([className, method]) => {
    try {
      const holder = Java.use(className);
      if (wrapOverloads(holder, method, function (overload, args) {
        const response = overload.apply(this, args);
        recordHttpResponse(response, `${className}.${method}`);
        return response;
      })) installed += 1;
    } catch {}
  });
  send({ tag: 'http-hook-ready', installed });
}

function fieldValue(object, ownerName, fieldName) {
  let clazz = object.getClass();
  while (clazz) {
    if (String(clazz.getName()) === ownerName) {
      const field = clazz.getDeclaredField(fieldName);
      field.setAccessible(true);
      return field.get(object);
    }
    clazz = clazz.getSuperclass();
  }
  return null;
}

function responseKey(field) {
  try {
    const annotations = field.getDeclaredAnnotations();
    for (let i = 0; i < annotations.length; i++) {
      const text = String(annotations[i]);
      const match = text.match(/value=([^,)]+)/);
      if (match && match[1] && match[1] !== 'class') return match[1];
    }
  } catch {}
  return String(field.getName());
}

function serialize(value, depth, seen) {
  if (value === null || value === undefined) return null;
  const clazz = value.getClass();
  const className = String(clazz.getName());
  if (/^java\.lang\.(String|Integer|Long|Float|Double|Boolean|Short|Byte|Character)$/.test(className)) {
    if (className === 'java.lang.Boolean') return Boolean(value.booleanValue());
    if (/String|Character/.test(className)) return String(value);
    return Number(String(value));
  }
  if (className === 'java.math.BigDecimal' || className === 'java.math.BigInteger') return String(value);
  if (clazz.isEnum()) return String(value);
  if (depth <= 0) return { _class: className };

  const System = Java.use('java.lang.System');
  const identity = `${className}:${System.identityHashCode(value)}`;
  if (seen.has(identity)) return { _ref: identity };
  seen.add(identity);

  const Collection = Java.use('java.util.Collection');
  if (Collection.class.isAssignableFrom(clazz)) {
    const collection = Java.cast(value, Collection);
    const rows = [];
    const iterator = collection.iterator();
    let index = 0;
    while (iterator.hasNext() && index < 200) {
      rows.push(serialize(iterator.next(), depth - 1, seen));
      index += 1;
    }
    return rows;
  }

  const MapClass = Java.use('java.util.Map');
  if (MapClass.class.isAssignableFrom(clazz)) {
    const map = Java.cast(value, MapClass);
    const result = {};
    const iterator = map.entrySet().iterator();
    let index = 0;
    while (iterator.hasNext() && index < 200) {
      const entry = iterator.next();
      result[String(entry.getKey())] = serialize(entry.getValue(), depth - 1, seen);
      index += 1;
    }
    return result;
  }

  if (/^com\.google\.gson\./.test(className)) {
    try { return { _class: className, _json: String(value) }; } catch { return { _class: className }; }
  }
  if (/^android\./.test(className) && !/^android\.graphics\.(Rect|RectF)$/.test(className)) return { _class: className };

  const Modifier = Java.use('java.lang.reflect.Modifier');
  const result = { _class: className };
  let current = clazz;
  let levels = 0;
  while (current && levels < 8) {
    const owner = String(current.getName());
    if (owner === 'java.lang.Object') break;
    const fields = current.getDeclaredFields();
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      try {
        if (Modifier.isStatic(field.getModifiers()) || Modifier.isTransient(field.getModifiers())) continue;
        const name = String(field.getName());
        if (/^(shadow\$_|renderNodeAtomicRef|goodsItemTransientData)/.test(name)) continue;
        field.setAccessible(true);
        result[responseKey(field)] = serialize(field.get(value), depth - 1, seen);
      } catch {}
    }
    current = current.getSuperclass();
    levels += 1;
  }
  return result;
}

function snapshotStore(store) {
  try {
    const products = fieldValue(store, 'Um.g', 'd');
    const Collection = Java.use('java.util.Collection');
    const collection = Java.cast(products, Collection);
    if (collection.size() <= 0) return [];
    const list = [];
    const iterator = collection.iterator();
    while (iterator.hasNext()) list.push(serialize(iterator.next(), 7, new Set()));
    return list;
  } catch {
    return [];
  }
}

// 把一个商品仓库实例序列化成 liveSnapshot。
function captureLiveSnapshotFromStore(store, viewInstance, adapterInstance) {
  try {
    const products = snapshotStore(store);
    if (!products.length) return;
    const signature = productSignature(products);
    if (liveSnapshot && liveSnapshot.signature === signature) return;
    liveSnapshot = {
      signature,
      products,
      capturedAt: Date.now(),
      storeClass: 'Um.g',
      entityClass: 'com.baogong.app_base_entity.h',
      viewClass: viewInstance ? String(viewInstance.getClass().getName()) : null,
      adapterClass: adapterInstance ? String(adapterInstance.getClass().getName()) : 'Lm.d',
    };
    liveSnapshotEpoch += 1;
    send({ tag: 'live-snapshot', epoch: liveSnapshotEpoch, signature, count: products.length });
  } catch (error) {
    send({ tag: 'live-snapshot-error', error: String(error && error.message || error) });
  }
}

// 主动 hook Lm.d.notifyDataSetChanged 等回调，把最新商品灌入 liveSnapshot；
// 这种"事件驱动"方式不依赖 UI 是否在前台，也避免每轮 RPC 都 Java.choose。
function installResultHooks() {
  const targets = [
    ['Lm.d', 'notifyDataSetChanged'],
    ['Lm.d', 'notifyItemRangeInserted'],
    ['Lm.d', 'notifyItemRangeChanged'],
    ['Lm.d', 'submitList'],
    ['com.baogong.business.ui.recycler.BGProductListView', 'setAdapter'],
    ['androidx.recyclerview.widget.RecyclerView', 'setAdapter'],
  ];
  let installed = 0;
  const logInstall = (msg) => { try { send({ tag: 'agent-log', message: msg }); } catch {} };
  for (const [className, methodName] of targets) {
    try {
      const holder = Java.use(className);
      const overloads = holder[methodName].overloads;
      if (!overloads || !overloads.length) continue;
      overloads.forEach((overload) => {
        overload.implementation = function () {
          const result = overload.apply(this, arguments);
          try {
            // 对 setAdapter：this 是 RecyclerView，需要先拿刚被设置的 adapter
            let adapter = this;
            if (className === 'com.baogong.business.ui.recycler.BGProductListView' || className === 'androidx.recyclerview.widget.RecyclerView') {
              adapter = arguments[0];
            }
            if (!adapter || String(adapter.getClass().getName()) !== 'Lm.d') return result;
            const store = fieldValue(adapter, 'Lm.d', 'f0');
            if (!store) return result;
            captureLiveSnapshotFromStore(store, className === 'Lm.d' ? null : this, adapter);
          } catch (error) {
            send({ tag: 'result-hook-error', className, methodName, error: String(error && error.message || error) });
          }
          return result;
        };
      });
      installed += 1;
    } catch (error) {
      send({ tag: 'result-hook-missing', className, methodName, error: String(error && error.message || error) });
    }
  }
  send({ tag: 'result-hook-ready', installed });
}

function snapshotKnownStores() {
  const candidates = knownStores.map(snapshotStore).filter((products) => products.length);
  candidates.sort((a, b) => b.length - a.length);
  const products = candidates[0] || [];
  return { products, signature: productSignature(products) };
}

function discoverStores() {
  return new Promise((resolve) => {
    try {
      Java.choose('Um.g', {
        onMatch(store) {
          try {
            if (!knownStores.some((item) => item.$h === store.$h)) knownStores.push(store);
          } catch {}
        },
        onComplete() {
          resolve(snapshotKnownStores());
        }
      });
    } catch {
      resolve({ products: [], signature: '' });
    }
  });
}

function collectOnce() {
  return new Promise((resolve) => {
    const candidates = [];
    const finish = () => {
      const candidate = candidates.find((item) => item.shown) || candidates[candidates.length - 1];
      if (!candidate) {
        send({ tag: 'export-error', error: '未找到已装载商品的图搜数据仓库' });
        resolve();
        return;
      }
      send({ tag: 'export-start', product_count: candidate.products.length, adapter_class: 'Lm.d', store_class: 'Um.g', entity_class: 'com.baogong.app_base_entity.h', shown: candidate.shown });
      candidate.products.forEach((product, index) => send({ tag: 'export-product', index, product }));
      send({ tag: 'export-complete', product_count: candidate.products.length });
      resolve();
    };

    // 优先直接读取商品数据仓库。接口响应写入 Um.g 后即可命中，不依赖结果页控件创建。
    try {
      Java.choose('Um.g', {
        onMatch(store) {
          try {
            const products = fieldValue(store, 'Um.g', 'd');
            const Collection = Java.use('java.util.Collection');
            const collection = Java.cast(products, Collection);
            if (collection.size() <= 0) return;
            const list = [];
            const iterator = collection.iterator();
            while (iterator.hasNext()) list.push(serialize(iterator.next(), 7, new Set()));
            candidates.push({ shown: false, products: list });
          } catch {}
        },
        onComplete() {
          if (candidates.length) finish();
          else collectFromViews();
        }
      });
    } catch {
      collectFromViews();
    }

    function collectFromViews() {
      Java.choose('com.baogong.business.ui.recycler.BGProductListView', {
      onMatch(instance) {
        try {
          const adapter = fieldValue(instance, 'androidx.recyclerview.widget.RecyclerView', 'E');
          if (!adapter || String(adapter.getClass().getName()) !== 'Lm.d') return;
          const store = fieldValue(adapter, 'Lm.d', 'f0');
          const products = fieldValue(store, 'Um.g', 'd');
          const Collection = Java.use('java.util.Collection');
          const collection = Java.cast(products, Collection);
          if (collection.size() <= 0) return;
          let shown = false;
          try { shown = instance.isShown(); } catch {}
          const list = [];
          const iterator = collection.iterator();
          while (iterator.hasNext()) list.push(serialize(iterator.next(), 7, new Set()));
          candidates.push({ shown, products: list });
        } catch { /* 非图搜列表或页面切换中的失效实例 */ }
      },
        onComplete() {
          finish();
        }
      });
    }
  });
}

Java.perform(() => {
  installResultHooks();
  // 默认不在 Temu 启动时挂载 OkHttp hook：
  // OkHttp 拦截链对 Accessibility/uiautomator dump 有可观察的副作用，
  // 而且仓库增量检测（installResultHooks）已能直接捕获商品写入。
  // 如需恢复诊断，按 TEMU_INSTALL_HTTP_HOOKS=1 重新打开。
  if (process.env.TEMU_INSTALL_HTTP_HOOKS === '1') {
    installHttpHooks();
  }
  // RPC 必须在 Java.perform 内同步赋值，且 result-hook-ready 必须在 rpc.exports = ... 之后发出，
  // 否则 daemon 会因为 race condition 拿到一个空的 script.exports。
  rpc.exports = {
    run_export() {
      return collectOnce();
    },
    arm_http(taskId) {
      // arm 阶段刻意不调用 Java.choose：Temu 启动早期全堆扫描很容易卡住，
      // 会让 /baseline 接口被拖到 30s 以上；更糟的是它会让 RPC 通道阻塞，
      // 导致后续 take_store_if_new 等调用全部 hang。基线留空，
      // 真正取数时由事件回调（installResultHooks）触发 liveSnapshot 增量获取。
      const armedAt = Date.now();
      const id = String(taskId);
      httpTasks.set(id, {
        armedAt,
        baselineSignature: '',
        baselineCount: 0,
        responses: [],
        samples: [],
        seen: 0,
        baselinePending: true, // 直到结果页回调触发 liveSnapshot 后才解除
      });
      // 不再后台触发 discoverStores：那条路径一旦 Java.choose 卡住，
      // 整条 RPC 通道都停摆，take_store_if_new 永远拿不到数据。
      return { taskId: id, armedAt, baselineCount: 0 };
    },
    snapshot_known_stores() {
      // 给 daemon 的 HTTP 探针使用：只读取已发现仓库的最新快照，绝不触发 Java.choose。
      return Promise.resolve(snapshotKnownStores());
    },
    live_snapshot() {
      // 调试用：直接把 hook 回调喂入的最新商品快照返回。
      if (!liveSnapshot) return Promise.resolve(null);
      return Promise.resolve({
        signature: liveSnapshot.signature,
        products: liveSnapshot.products,
        capturedAt: liveSnapshot.capturedAt,
        epoch: liveSnapshotEpoch,
        adapterClass: liveSnapshot.adapterClass,
        viewClass: liveSnapshot.viewClass,
        storeClass: liveSnapshot.storeClass,
      });
    },
    take_store_if_new(taskId) {
      const task = httpTasks.get(String(taskId));
      if (!task) return Promise.resolve(null);
      // 1) 优先看结果页回调是否已经把当前商品喂入 liveSnapshot。
      if (liveSnapshot && liveSnapshot.products && liveSnapshot.products.length) {
        if (liveSnapshot.signature !== task.baselineSignature) {
          return Promise.resolve({
            products: liveSnapshot.products,
            signature: liveSnapshot.signature,
            baselineSignature: task.baselineSignature,
            capturedAt: liveSnapshot.capturedAt,
            source: 'response-deserialized-store',
            adapterClass: liveSnapshot.adapterClass,
            storeClass: liveSnapshot.storeClass,
          });
        }
        return Promise.resolve(null);
      }
      // 2) 兜底：尚未触发回调时，读已知仓库；不再同步触发 Java.choose。
      // Temu 启动早期全堆扫描很容易卡 5-30s，把 /baseline 拉满。把发现交给后台的
      // discoverStores()，RPC 这边只读 knownStores。baselinePending 时直接 null。
      if (task.baselinePending) {
        return Promise.resolve(null);
      }
      let snapshot = snapshotKnownStores();
      if (!snapshot.products.length && !knownStores.length) {
        // 已知仓库都为空，且后台发现也没拿到 → 等下一次回调，不要挂 RPC。
        return Promise.resolve(null);
      }
      if (!snapshot.products.length || snapshot.signature === task.baselineSignature) return Promise.resolve(null);
      return Promise.resolve({
        products: snapshot.products,
        signature: snapshot.signature,
        baselineSignature: task.baselineSignature,
        capturedAt: Date.now(),
        source: 'response-deserialized-store',
      });
    },
    take_http(taskId) {
      const key = String(taskId);
      const task = httpTasks.get(key);
      if (!task) return [];
      const responses = task.responses.splice(0, task.responses.length);
      return responses;
    },
    http_stats(taskId) {
      const task = httpTasks.get(String(taskId));
      if (!task) return null;
      return {
        armedAt: task.armedAt,
        seen: task.seen,
        pendingResponses: task.responses.length,
        samples: task.samples,
      };
    },
    clear_http(taskId) {
      return httpTasks.delete(String(taskId));
    },
  };
  // 在 rpc.exports 赋值完成后再发一次 agent-ready，让 daemon 看到 exports 已经就绪。
  send({ tag: 'agent-ready', exports: Object.keys(rpc.exports) });
});