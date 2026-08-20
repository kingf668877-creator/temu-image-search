import Java from 'frida-java-bridge';

globalThis.Java = Java;

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

Java.perform(() => {
  let exported = false;
  Java.choose('com.baogong.business.ui.recycler.BGProductListView', {
    onMatch(instance) {
      if (exported) return;
      let shown = false;
      try { shown = instance.isShown(); } catch {}
      if (!shown) return;
      try {
        const adapter = fieldValue(instance, 'androidx.recyclerview.widget.RecyclerView', 'E');
        if (!adapter || String(adapter.getClass().getName()) !== 'Lm.d') return;
        const store = fieldValue(adapter, 'Lm.d', 'f0');
        const products = fieldValue(store, 'Um.g', 'd');
        const Collection = Java.use('java.util.Collection');
        const collection = Java.cast(products, Collection);
        send({ tag: 'export-start', product_count: collection.size(), adapter_class: 'Lm.d', store_class: 'Um.g', entity_class: 'com.baogong.app_base_entity.h' });
        const iterator = collection.iterator();
        let index = 0;
        while (iterator.hasNext()) {
          const product = iterator.next();
          send({ tag: 'export-product', index, product: serialize(product, 7, new Set()) });
          index += 1;
        }
        send({ tag: 'export-complete', product_count: index });
        exported = true;
      } catch (error) {
        send({ tag: 'export-error', error: String(error) });
      }
    },
    onComplete() {
      if (!exported) send({ tag: 'export-error', error: '未找到当前可见的图搜商品列表' });
    }
  });
});
