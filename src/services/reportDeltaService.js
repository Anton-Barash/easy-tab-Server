// ============================================================
// Report Delta Service — вычисление и применение JSON-дельты
// для optimistic locking на уровне отдельных вопросов.
// ============================================================

const logger = require('../utils/logger');

/**
 * Проверяет, является ли значением примитивом (не объектом/массивом).
 */
function isPrimitive(value) {
  return value === null || (typeof value !== 'object' && typeof value !== 'function');
}

/**
 * Глубокое сравнение двух значений.
 */
function deepEqual(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (isPrimitive(a) || isPrimitive(b)) return a === b;

  if (Array.isArray(a) !== Array.isArray(b)) return false;

  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }

  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;

  for (const key of keysA) {
    if (!Object.prototype.hasOwnProperty.call(b, key)) return false;
    if (!deepEqual(a[key], b[key])) return false;
  }
  return true;
}

/**
 * Рекурсивно вычисляет дельту между base и target.
 * Возвращает массив операций { op: 'set', path: string[], value }.
 * Путь — это массив ключей/индексов.
 *
 * Особенность: для массивов сравниваем по индексам. Если длина массива
 * изменилась — записываем ВЕСЬ массив целиком (операция по пути массива),
 * чтобы избежать риска неправильной интерпретации сдвигов.
 */
function computeDelta(base, target, path = []) {
  const delta = [];

  if (deepEqual(base, target)) {
    return delta;
  }

  // Оба примитивы или разные типы — заменяем целиком.
  if (isPrimitive(base) || isPrimitive(target)) {
    delta.push({ op: 'set', path: [...path], value: target });
    return delta;
  }

  // Один массив, другой объект — заменяем целиком.
  if (Array.isArray(base) !== Array.isArray(target)) {
    delta.push({ op: 'set', path: [...path], value: target });
    return delta;
  }

  if (Array.isArray(base)) {
    // Если массив укоротился — перезаписываем весь массив, чтобы не
    // оставлять разреженные null-элементы.
    if (target.length < base.length) {
      delta.push({ op: 'set', path: [...path], value: target });
      return delta;
    }
    // Дифф общей части поэлементно.
    for (let i = 0; i < base.length; i += 1) {
      delta.push(...computeDelta(base[i], target[i], [...path, i]));
    }
    // Добавленные элементы — отдельные операции.
    for (let i = base.length; i < target.length; i += 1) {
      delta.push({ op: 'set', path: [...path, i], value: target[i] });
    }
    return delta;
  }

  // Объекты: сравниваем ключи.
  const allKeys = new Set([...Object.keys(base), ...Object.keys(target)]);
  for (const key of allKeys) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) {
      // Новый ключ — добавляем.
      delta.push({ op: 'set', path: [...path, key], value: target[key] });
    } else if (!Object.prototype.hasOwnProperty.call(target, key)) {
      // Удалённый ключ — записываем null.
      delta.push({ op: 'set', path: [...path, key], value: null });
    } else {
      delta.push(...computeDelta(base[key], target[key], [...path, key]));
    }
  }

  return delta;
}

/**
 * Проверяет, пересекаются ли пути двух дельт.
 * Пересечение = один путь является префиксом другого.
 */
function deltasIntersect(deltaA, deltaB) {
  for (const opA of deltaA) {
    for (const opB of deltaB) {
      const minLen = Math.min(opA.path.length, opB.path.length);
      let same = true;
      for (let i = 0; i < minLen; i += 1) {
        if (opA.path[i] !== opB.path[i]) {
          same = false;
          break;
        }
      }
      if (same) return true;
    }
  }
  return false;
}

/**
 * Применяет дельту к JSON-объекту, возвращая НОВЫЙ объект (immutable).
 */
function applyDelta(data, delta) {
  if (!delta || delta.length === 0) return data;

  // Глубокая копия для иммутабельности.
  const result = JSON.parse(JSON.stringify(data));

  for (const { path, value } of delta) {
    if (path.length === 0) {
      // Замена корня — не ожидается в штатной работе.
      logger.warn('applyDelta: attempt to replace root object');
      continue;
    }

    let current = result;
    for (let i = 0; i < path.length - 1; i += 1) {
      const key = path[i];
      current = current[key];
      if (current == null) {
        logger.warn(`applyDelta: path not found ${path.join('.')}`);
        break;
      }
    }
    if (current != null) {
      current[path[path.length - 1]] = value;
    }
  }

  return result;
}

/**
 * Извлекает ключ конфликта на уровне подответа из операции дельты.
 * Учитываем только изменение текста ответа: translations[qid][lang][answerIndex].text.
 */
function extractAnswerConflictKey(op) {
  if (!op || !Array.isArray(op.path)) return null;
  const p = op.path;
  // Конфликт подответа определяем по изменению текста ответа.
  if (p[0] === 'translations' && p.length >= 5 && p[4] === 'text') {
    const qid = p[1];
    const answerIndex = p[3];
    if (/^\d+$/.test(String(qid)) && typeof answerIndex === 'number') {
      return {
        key: `${qid}:${answerIndex}`,
        qid,
        answerIndex,
        lang: p[2],
      };
    }
  }
  return null;
}

/**
 * Находит конфликты на уровне отдельных подответов.
 * Два изменения разных подответов одного вопроса НЕ считаются конфликтом.
 *
 * Возвращает массив объектов:
 *   { questionIndex, answerIndex, language, serverText, clientText }
 */
function buildAnswerConflicts(clientDelta, serverDelta, currentData, newReportData) {
  const clientKeys = new Map();
  for (const op of clientDelta) {
    const info = extractAnswerConflictKey(op);
    if (info) clientKeys.set(info.key, info);
  }

  const serverKeys = new Map();
  for (const op of serverDelta) {
    const info = extractAnswerConflictKey(op);
    if (info) serverKeys.set(info.key, info);
  }

  const conflicts = [];
  const defaultLang = currentData?.currentLanguage || 'RU';
  for (const [key, info] of clientKeys) {
    if (!serverKeys.has(key)) continue;
    const lang = info.lang || defaultLang;
    const serverText = currentData?.translations?.[info.qid]?.[lang]?.[info.answerIndex]?.text ?? '';
    const clientText = newReportData?.translations?.[info.qid]?.[lang]?.[info.answerIndex]?.text ?? '';
    conflicts.push({
      questionIndex: parseInt(info.qid, 10),
      answerIndex: info.answerIndex,
      language: lang,
      serverText,
      clientText,
    });
  }
  return conflicts;
}

module.exports = {
  computeDelta,
  applyDelta,
  deltasIntersect,
  buildAnswerConflicts,
};
