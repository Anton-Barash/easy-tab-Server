// ============================================================
// Report Ops Service — merge-by-ID на сервере (Фаза 4).
//
// Контракт: docs/SERVER_SYNC_SPEC.md §3-4.
//   ops: question.add/remove, answer.add/update/remove/setMedia/setMarkers, meta
// Результат applyOps: { conflicts, doc } — при conflicts[] документ НЕ меняется
// (вызывающий должен вернуть 409 VERSION_CONFLICT).
//
// Документ приводится к canonical-виду (questions + answers {qid:[rows]}),
// после merge на выходе прикрепляются legacy-зеркала translations/markers
// (совместимость со старыми клиентами и экспортом).
// ============================================================

const { randomUUID } = require('node:crypto');
const logger = require('../utils/logger');

const isPlainObject = (v) =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const clone = (v) => JSON.parse(JSON.stringify(v));

function uniqueId() {
  return randomUUID();
}

function firstInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function cellUpdatedAt(cell) {
  if (!isPlainObject(cell)) return 0;
  if (typeof cell.updatedAt === 'number') return cell.updatedAt;
  if (typeof cell.updatedAt === 'string') {
    const n = Number(cell.updatedAt);
    if (Number.isInteger(n)) return n;
  }
  if (typeof cell.createdAt === 'number') return cell.createdAt;
  return 0;
}

/**
 * Гарантирует qid у всех вопросов (миграция old-документов).
 */
function ensureQuestionQids(doc) {
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  questions.forEach((q, idx) => {
    if (!isPlainObject(q)) return;
    if (!q.qid || typeof q.qid !== 'string') q.qid = uniqueId();
    q.legacyId = firstInt(q.legacyId) ?? idx;
  });
  return doc;
}

/**
 * Ключ qid->индекс по порядку вопросов.
 */
function qidToIndexMap(doc) {
  const map = {};
  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  questions.forEach((q, idx) => {
    if (isPlainObject(q) && q.qid) map[String(q.qid)] = idx;
  });
  return map;
}

/**
 * Приводит документ к canonical-виду (добавляет doc.answers {qid: [rows]}),
 * если его нет. Для legacy (translations/markers) собирает строки по индексам.
 * Возвращает тот же объект (мутация клона на стороне вызывающего).
 */
function buildCanonical(doc) {
  ensureQuestionQids(doc);
  if (isPlainObject(doc.answers) && Object.keys(doc.answers).length > 0) {
    return doc;
  }

  const questions = Array.isArray(doc.questions) ? doc.questions : [];
  const translations = isPlainObject(doc.translations) ? doc.translations : {};
  const markers = isPlainObject(doc.markers) ? doc.markers : {};
  const availableLanguages = Array.isArray(doc.availableLanguages)
    ? doc.availableLanguages
    : ['RU'];
  const answers = {};

  questions.forEach((q, index) => {
    const key = String(index);
    const langMap = isPlainObject(translations[key]) ? translations[key] : {};
    const markerRows = Array.isArray(markers[key]) ? markers[key] : [];
    const qid = q.qid;

    // Собираем языки, чтобы каждый ряд имел ячейку для всех языков.
    const allLangs = [...new Set([...Object.keys(langMap), ...availableLanguages])];

    let rowCount = 0;
    for (const list of Object.values(langMap)) {
      if (Array.isArray(list) && list.length > rowCount) rowCount = list.length;
    }
    if (markerRows.length > rowCount) rowCount = markerRows.length;

    const rows = [];
    for (let r = 0; r < rowCount; r += 1) {
      let rid = null;
      if (markerRows[r] && typeof markerRows[r].rowId === 'string') {
        rid = markerRows[r].rowId;
      }
      if (!rid) {
        for (const list of Object.values(langMap)) {
          const cell = Array.isArray(list) ? list[r] : null;
          if (cell && typeof cell.rowId === 'string') {
            rid = cell.rowId;
            break;
          }
        }
      }
      if (!rid) rid = uniqueId();

      const cells = {};
      for (const lang of allLangs) {
        const list = Array.isArray(langMap[lang]) ? langMap[lang] : [];
        const cell = list[r];
        if (isPlainObject(cell)) {
          cells[lang] = {
            ...cell,
            rowId: cell.rowId || rid,
          };
        } else {
          cells[lang] = {
            id: uniqueId(),
            text: '',
            isEmpty: true,
            authorId: 'anon:' + uniqueId(),
            authorIsAnonymous: true,
            createdAt: Date.now(),
            rowId: rid,
          };
        }
      }

      const marker = isPlainObject(markerRows[r])
        ? markerRows[r]
        : { attention: false, media: [], needsWork: false };
      rows.push({
        rid,
        legacyIndex: r,
        localizations: cells,
        markers: { ...marker, rowId: marker.rowId || rid },
      });
    }
    answers[qid] = rows;
  });

  doc.answers = answers;
  return doc;
}

/**
 * Пересобирает legacy-зеркала translations/markers из canonical answers
 * (для совместимости со старыми клиентами).
 */
function attachLegacyMirrors(doc) {
  const translations = {};
  const markers = {};
  const answers = isPlainObject(doc.answers) ? doc.answers : {};
  const questions = Array.isArray(doc.questions) ? doc.questions : [];

  questions.forEach((q, index) => {
    const key = String(index);
    const rows = Array.isArray(answers[q.qid]) ? answers[q.qid] : [];
    translations[key] = {};
    markers[key] = [];

    for (const row of rows) {
      const cells = isPlainObject(row.localizations) ? row.localizations : {};
      for (const lang of Object.keys(cells)) {
        if (!Array.isArray(translations[key][lang])) translations[key][lang] = [];
        translations[key][lang].push(cells[lang]);
      }
      const marker = isPlainObject(row.markers)
        ? row.markers
        : { attention: false, media: [], needsWork: false };
      markers[key].push({ ...marker, rowId: row.rid });
    }
  });

  doc.translations = translations;
  doc.markers = markers;
  doc.schemaVersion = 2;
  return doc;
}

function findRowIndex(rows, rid) {
  if (!Array.isArray(rows)) return -1;
  return rows.findIndex((row) => isPlainObject(row) && String(row.rid) === String(rid));
}

/**
 * Fingerprint строки (без учёта id): нормализованная конкатенация текстов
 * по языкам. Пустая строка -> '' (для миграционных дедупов не кандидат).
 */
function rowFingerprint(row) {
  if (!isPlainObject(row)) return '';
  const cells = isPlainObject(row.localizations) ? row.localizations : {};
  const parts = Object.keys(cells)
    .sort()
    .map((lang) => {
      const cell = cells[lang];
      const text = isPlainObject(cell) ? String(cell.text ?? '') : '';
      return `${lang}:${text}`;
    })
    .join('||');
  return parts;
}

/**
 * Есть ли у строки реальное содержимое (хотя бы один непустой текст).
 * Пустые «заглушки» не участвуют в дедупе параллельной миграции.
 */
function rowHasContent(row) {
  if (!isPlainObject(row)) return false;
  const cells = isPlainObject(row.localizations) ? row.localizations : {};
  return Object.keys(cells).some((lang) => {
    const cell = cells[lang];
    return isPlainObject(cell) && String(cell.text ?? '').trim() !== '';
  });
}

/**
 * Ищет в строках вопроса кандидата на дедуп: один и тот же legacyIndex
 * И одинаковый fingerprint (не пустой). Используется, когда два клиента
 * независимо мигрировали один legacy-документ и прислали разные rid.
 */
function findDedupCandidate(rows, row, newRid) {
  if (!Array.isArray(rows)) return -1;
  if (!rowHasContent(row)) return -1;
  const fingerprint = rowFingerprint(row);
  const legacyIndex = row.legacyIndex;
  return rows.findIndex(
    (candidate) =>
      isPlainObject(candidate) &&
      String(candidate.rid) !== String(newRid) &&
      legacyIndex != null &&
      candidate.legacyIndex === legacyIndex &&
      rowFingerprint(candidate) === fingerprint
  );
}

/**
 * Fingerprint локализаций вопроса (lang -> поля, ключи сортированы).
 */
function localizationsFingerprint(loc) {
  if (!isPlainObject(loc)) return '';
  const langs = Object.keys(loc).sort();
  const parts = langs.map((lang) => {
    const value = isPlainObject(loc[lang]) ? loc[lang] : {};
    const keys = Object.keys(value).sort();
    const fields = keys.map((k) => `${k}:${JSON.stringify(value[k])}`).join(';');
    return `${lang}{${fields}}`;
  });
  return parts.join('||');
}

/**
 * Ищет кандидата на дедуп вопроса: одинаковый legacyId И одинаковые
 * локализации. Применяется для параллельной миграции одного legacy-документа,
 * когда клиенты присваивают разные qid.
 */
function findQuestionDedupCandidate(questions, q, newQid) {
  if (!Array.isArray(questions)) return -1;
  if (q.legacyId === undefined || q.legacyId === null) return -1;
  const fingerprint = localizationsFingerprint(q.localizations);
  if (!fingerprint) return -1;
  return questions.findIndex(
    (candidate) =>
      isPlainObject(candidate) &&
      String(candidate.qid) !== String(newQid) &&
      candidate.legacyId === q.legacyId &&
      localizationsFingerprint(candidate.localizations) === fingerprint
  );
}

/**
 * Применяет ops к canonical-документу.
 * @param {object} doc
 * @param {Array} ops
 * @param {{authorId?: string, isAnonymous?: boolean}} [options] — для аудита:
 *   если передан authorId, сервер переопределяет authorId ячеек, создаваемых
 *   и изменяемых этими ops (см. спец. §3.1 / §4).
 * @returns {{conflicts: Array, applied: number, doc: object}}
 *   conflicts не пуст => применять документ НЕЛЬЗЯ (409).
 */
function applyOps(doc, ops, options) {
  const opts = options || {};
  const actorAuthorId = typeof opts.authorId === 'string' && opts.authorId !== ''
    ? opts.authorId
    : null;

  // Переопределяет автора у языковых ячеек (аудит: server принимает только
  // user:<id> от аутентифицированных клиентов).
  const stampAuthorCells = (localizations) => {
    if (!actorAuthorId || !isPlainObject(localizations)) return;
    for (const lang of Object.keys(localizations)) {
      const cell = localizations[lang];
      if (isPlainObject(cell)) {
        cell.authorId = actorAuthorId;
        cell.authorIsAnonymous = false;
      }
    }
  };

  const current = clone(doc);
  buildCanonical(current);
  const conflicts = [];
  let applied = 0;
  // rid-алиасы от дедупа параллельной миграции (client rid -> server rid).
  const ridAlias = {};
  // qid-алиасы от дедупа параллельной миграции (client qid -> server qid).
  const qidAlias = {};

  const questions = Array.isArray(current.questions) ? current.questions : [];
  const qidIndex = {};
  questions.forEach((q, i) => {
    if (isPlainObject(q) && q.qid) qidIndex[String(q.qid)] = i;
  });

  for (const op of Array.isArray(ops) ? ops : []) {
    if (!isPlainObject(op)) continue;
    const t = op.t;

    // ---------- meta ----------
    if (t === 'meta') {
      const fields = isPlainObject(op.fields) ? op.fields : {};
      for (const key of Object.keys(fields)) {
        current[key] = fields[key];
      }
      applied += 1;
      continue;
    }

    // ---------- questions ----------
    if (t === 'question.remove') {
      const rawQid = String(op.qid || '');
      const qid = qidAlias[rawQid] || rawQid;
      const idx = qidIndex[qid];
      if (idx != null) {
        current.questions.splice(idx, 1);
        delete current.answers[qid];
        // Перестраиваем индекс.
        Object.keys(qidIndex).forEach((k) => {
          if (qidIndex[k] > idx) qidIndex[k] -= 1;
        });
        delete qidIndex[qid];
        applied += 1;
      }
      continue;
    }

    if (t === 'question.add') {
      const qid = String(op.qid || '');
      if (!qid || qidIndex[qid] != null) {
        if (qid && qidIndex[qid] == null) applied += 1; // добавлен повторно — no-op
        continue;
      }
      const q = isPlainObject(op.question) ? clone(op.question) : {};
      q.qid = qid;
      if (q.legacyId === undefined || q.legacyId === null) {
        q.legacyId = undefined;
      }

      // Дедуп параллельной миграции: тот же legacyId и локализации => не
      // создаём второй вопрос, алиасим qid клиента на существующий.
      const dupQIndex = findQuestionDedupCandidate(questions, q, qid);
      if (dupQIndex >= 0) {
        const existingQid = String(questions[dupQIndex].qid);
        qidAlias[qid] = existingQid;
        applied += 1;
        continue;
      }

      const afterQid = op.afterQid == null ? null : String(op.afterQid);
      const afterIdx = afterQid ? qidIndex[afterQid] : null;
      const insertAt = afterIdx == null ? current.questions.length : afterIdx + 1;
      current.questions.splice(insertAt, 0, q);
      if (!isPlainObject(current.answers)) current.answers = {};
      current.answers[qid] = [];

      Object.keys(qidIndex).forEach((k) => {
        if (qidIndex[k] >= insertAt) qidIndex[k] += 1;
      });
      qidIndex[qid] = insertAt;
      applied += 1;
      continue;
    }

    // ---------- answers ----------
    const rawQid = String(op.qid || '');
    const qid = qidAlias[rawQid] || rawQid;
    const qIdx = qidIndex[qid];
    if (qIdx == null) {
      // Вопрос не существует — вопрос.add должен был прийти раньше.
      logger.warn(`applyOps: unknown question ${qid}, op=${t}`);
      continue;
    }
    const rows = Array.isArray(current.answers[qid]) ? current.answers[qid] : [];
    const rawRid = String(op.rid || '');

    if (t === 'answer.add') {
      const rid = rawRid;
      if (!rid) continue;
      // Идемпотентность: id уже существует.
      if (findRowIndex(rows, rid) >= 0) {
        applied += 1;
        continue;
      }
      const row = isPlainObject(op.row) ? clone(op.row) : {};
      row.rid = rid;
      // Аудит: автор ячеек новой строки = аутентифицированный пользователь.
      stampAuthorCells(row.localizations);

      // Дедуп при параллельной миграции одного legacy-документа: два клиента
      // прислали разные rid для одной и той же строки (одинаковые legacyIndex
      // и fingerprint). Не дублируем — привязываем alias к существующей строке.
      const candidate = findDedupCandidate(rows, row, rid);
      if (candidate >= 0) {
        const canonicalRid = String(rows[candidate].rid);
        ridAlias[rid] = canonicalRid;
        applied += 1;
        continue;
      }

      const afterRid = op.afterRid == null ? null : String(op.afterRid);
      const afterIdx = afterRid ? findRowIndex(rows, afterRid) : -1;
      const insertAt = afterIdx >= 0 ? afterIdx + 1 : rows.length;
      rows.splice(insertAt, 0, row);
      applied += 1;
      continue;
    }

    // Для остальных answer-операций разрешаем возможный alias от дедупа.
    const rid = ridAlias[rawRid] || rawRid;
    const rowIdx = findRowIndex(rows, rid);

    if (t === 'answer.remove') {
      if (rowIdx >= 0) {
        rows.splice(rowIdx, 1);
        applied += 1;
      }
      continue;
    }

    if (t === 'answer.setMedia') {
      if (rowIdx < 0) continue;
      if (!isPlainObject(rows[rowIdx].markers)) rows[rowIdx].markers = {};
      rows[rowIdx].markers.media = Array.isArray(op.media)
        ? clone(op.media)
        : [];
      rows[rowIdx].markers.rowId = rows[rowIdx].rid;
      applied += 1;
      continue;
    }

    if (t === 'answer.setMarkers') {
      if (rowIdx < 0) continue;
      if (!isPlainObject(rows[rowIdx].markers)) rows[rowIdx].markers = {};
      const m = isPlainObject(op.markers) ? op.markers : {};
      // attention/needsWork — last-write-wins (как media): это независимые
      // флаги строки, конфликтов по ним не требуется.
      if (typeof m.attention === 'boolean') {
        rows[rowIdx].markers.attention = m.attention;
      }
      if (typeof m.needsWork === 'boolean') {
        rows[rowIdx].markers.needsWork = m.needsWork;
      }
      rows[rowIdx].markers.rowId = rows[rowIdx].rid;
      applied += 1;
      continue;
    }

    if (t === 'answer.update') {
      const lang = String(op.lang || '');
      if (rowIdx < 0) continue;
      const cells = isPlainObject(rows[rowIdx].localizations)
        ? rows[rowIdx].localizations
        : {};
      const cell = isPlainObject(cells[lang]) ? cells[lang] : null;
      const newText = isPlainObject(op.fields)
        ? String(op.fields.text ?? '')
        : '';
      if (!cell) continue;

      const baseUpdatedAt =
        op.baseUpdatedAt != null ? firstInt(op.baseUpdatedAt) : null;
      const currentTs = cellUpdatedAt(cell);
      const serverText = String(cell.text ?? '');

      if (serverText === newText) {
        applied += 1; // no-op (в т.ч. параллельная правка тем же значением)
        continue;
      }

      // Конфликт: серверная ячейка уже не та, на основе которой клиент
      // строил правку (значит её изменил кто-то другой — другой пользователь
      // или другое анонимное устройство по share-ссылке).
      //
      // Признак №1 — текст в базе клиента не совпадает с серверным: не
      // зависит от часов устройств.
      // Признак №2 — время изменения ячейки отличается от базового: ловит
      // случаи, когда текст совпал, но правка была (и страхует старые
      // клиенты без baseText). Сравниваем только осмысленные (>0) метки,
      // иначе «неизвестное» время давало бы ложные конфликты.
      const baseText = op.baseText != null ? String(op.baseText) : null;
      const textChangedByOther = baseText != null && serverText !== baseText;
      const tsChanged =
        baseUpdatedAt != null &&
        baseUpdatedAt > 0 &&
        currentTs > 0 &&
        currentTs !== baseUpdatedAt;
      if (textChangedByOther || tsChanged) {
        conflicts.push({
          qid: rawQid,
          rid: rawRid,
          lang,
          field: 'text',
          serverText,
          clientText: newText,
          serverUpdatedAt: currentTs,
          clientUpdatedAt: firstInt(op.fields?.updatedAt) ?? null,
          // Кто последним правил ячейку на сервере (для информирования клиента).
          serverAuthor:
            typeof cell.authorId === 'string' && cell.authorId !== ''
              ? cell.authorId
              : null,
        });
        continue;
      }

      cell.text = newText;
      cell.isEmpty = newText === '';
      if (op.fields && op.fields.updatedAt != null) {
        cell.updatedAt = firstInt(op.fields.updatedAt) ?? Date.now();
      } else {
        cell.updatedAt = Date.now();
      }
      // Аудит: изменение ячейки приписывается текущему пользователю.
      if (actorAuthorId) {
        cell.authorId = actorAuthorId;
        cell.authorIsAnonymous = false;
      }
      applied += 1;
      continue;
    }

    logger.warn(`applyOps: unknown op type ${t}`);
  }

  if (conflicts.length > 0) {
    return { conflicts, applied, doc: current };
  }

  attachLegacyMirrors(current);
  return { conflicts, applied, doc: current };
}

/**
 * Полный merge ops: canonicalize -> applyOps -> mirrors.
 * @param {object} doc
 * @param {Array} ops
 * @param {{authorId?: string}} [options] — см. applyOps.
 * @returns {{conflicts: Array, applied: number, doc: object|null}}
 */
function mergeReportOps(doc, ops, options) {
  return applyOps(doc, ops, options);
}

module.exports = {
  ensureQuestionQids,
  buildCanonical,
  attachLegacyMirrors,
  applyOps,
  mergeReportOps,
  qidToIndexMap,
};
