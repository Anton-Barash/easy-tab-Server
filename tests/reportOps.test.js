// Тесты merge-by-ID ops движка (без БД).
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  applyOps,
  mergeReportOps,
  buildCanonical,
  attachLegacyMirrors,
} = require('../src/services/reportOpsService');

function docWithRows(rows) {
  return {
    schemaVersion: 2,
    reportName: 'Report',
    availableLanguages: ['RU'],
    currentLanguage: 'RU',
    questions: [{ id: 0, qid: 'q1', localizations: {} }],
    answers: {
      q1: rows.map((rid, i) => ({
        rid,
        legacyIndex: i,
        localizations: {
          RU: {
            id: `cell-${rid}`,
            text: '',
            isEmpty: true,
            createdAt: 1,
            updatedAt: 1,
          },
        },
      })),
    },
  };
}

test('два клиента добавляют по ответу — оба сохраняются без конфликта', () => {
  const base = docWithRows(['r1']);

  const afterA = applyOps(base, [
    { t: 'answer.add', qid: 'q1', rid: 'r2', afterRid: 'r1', row: docWithRows(['r2']).answers.q1[0] },
  ]);
  assert.strictEqual(afterA.conflicts.length, 0);
  assert.deepStrictEqual(
    afterA.doc.answers.q1.map((r) => r.rid),
    ['r1', 'r2']
  );

  const afterB = applyOps(afterA.doc, [
    { t: 'answer.add', qid: 'q1', rid: 'r3', afterRid: 'r2', row: docWithRows(['r3']).answers.q1[0] },
  ]);
  assert.strictEqual(afterB.conflicts.length, 0);
  assert.deepStrictEqual(
    afterB.doc.answers.q1.map((r) => r.rid),
    ['r1', 'r2', 'r3']
  );
});

test('конфликт одной ячейки: baseUpdatedAt устарел -> 409-подобный conflicts', () => {
  const base = docWithRows(['r1']);
  base.answers.q1[0].localizations.RU.text = 'общий';
  base.answers.q1[0].localizations.RU.updatedAt = 3; // серверная ячейка

  const result = applyOps(base, [
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'r1',
      lang: 'RU',
      baseUpdatedAt: 1, // клиент видел старую версию
      fields: { text: 'мой текст', updatedAt: 2 },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].serverText, 'общий');
  assert.strictEqual(result.conflicts[0].clientText, 'мой текст');
  // Документ не изменился.
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.text, 'общий');
});

test('update с актуальным baseUpdatedAt применяется', () => {
  const base = docWithRows(['r1']);
  base.answers.q1[0].localizations.RU.text = 'старое';
  base.answers.q1[0].localizations.RU.updatedAt = 7;

  const result = applyOps(base, [
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'r1',
      lang: 'RU',
      baseUpdatedAt: 7,
      fields: { text: 'новое', updatedAt: 8 },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.text, 'новое');
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.updatedAt, 8);
});

test('baseText расходится с сервером -> конфликт (правку сделал другой автор)', () => {
  const base = docWithRows(['r1']);
  base.answers.q1[0].localizations.RU.text = 'вариант-А';
  base.answers.q1[0].localizations.RU.updatedAt = 5;
  base.answers.q1[0].localizations.RU.authorId = 'share:t1:anonA';

  const result = applyOps(base, [
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'r1',
      lang: 'RU',
      // Время совпадает (часы клиента не помогают), но текст базы другой:
      // клиент правил «вариант-owner», а на сервере уже «вариант-А».
      baseUpdatedAt: 5,
      baseText: 'вариант-owner',
      fields: { text: 'мой текст', updatedAt: 5 },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 1);
  assert.strictEqual(result.conflicts[0].serverText, 'вариант-А');
  assert.strictEqual(result.conflicts[0].serverAuthor, 'share:t1:anonA');
  // Чужая правка не затёрта.
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.text, 'вариант-А');
});

test('baseText совпадает -> правка применяется без конфликта', () => {
  const base = docWithRows(['r1']);
  base.answers.q1[0].localizations.RU.text = 'база';
  base.answers.q1[0].localizations.RU.updatedAt = 9;

  const result = applyOps(base, [
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'r1',
      lang: 'RU',
      baseUpdatedAt: 9,
      baseText: 'база',
      fields: { text: 'моё', updatedAt: 10 },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.text, 'моё');
});

test('добавление вопроса с ответом и удаление', () => {
  const base = docWithRows(['r1']);

  const added = applyOps(base, [
    { t: 'question.add', qid: 'q-new', afterQid: 'q1', question: { localizations: {} } },
    { t: 'answer.add', qid: 'q-new', rid: 'rn1', afterRid: null, row: docWithRows(['rn1']).answers.q1[0] },
  ]);
  assert.strictEqual(added.conflicts.length, 0);
  assert.deepStrictEqual(added.doc.questions.map((q) => q.qid), ['q1', 'q-new']);
  assert.deepStrictEqual(added.doc.answers['q-new'].map((r) => r.rid), ['rn1']);

  const removed = applyOps(added.doc, [{ t: 'question.remove', qid: 'q-new' }]);
  assert.deepStrictEqual(removed.doc.questions.map((q) => q.qid), ['q1']);
  assert.strictEqual(removed.doc.answers['q-new'], undefined);
});

test('legacy документ (translations/markers) мигрируется и принимает ops', () => {
  const legacy = {
    schemaVersion: 1,
    reportName: 'Legacy',
    availableLanguages: ['RU'],
    currentLanguage: 'RU',
    questions: [{ id: 0, localizations: {} }],
    translations: {
      '0': {
        RU: [{ id: 'cell1', text: 'привет', isEmpty: false, createdAt: 1, updatedAt: 2 }],
      },
    },
    markers: {
      '0': [{ attention: false, media: [], needsWork: false }],
    },
  };

  buildCanonical(legacy);
  const qid = legacy.questions[0].qid;
  assert.ok(qid);
  assert.ok(Array.isArray(legacy.answers[qid]));
  assert.strictEqual(legacy.answers[qid][0].localizations.RU.text, 'привет');

  const result = applyOps(legacy, [
    { t: 'answer.update', qid, rid: legacy.answers[qid][0].rid, lang: 'RU', baseUpdatedAt: 2, fields: { text: 'обновлено', updatedAt: 3 } },
  ]);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.doc.answers[qid][0].localizations.RU.text, 'обновлено');
  // После успешного merge приложены legacy-зеркала.
  attachLegacyMirrors(result.doc);
  assert.strictEqual(result.doc.translations['0'].RU[0].text, 'обновлено');
  assert.strictEqual(result.doc.schemaVersion, 2);
});

test('meta: переименование отчёта', () => {
  const base = docWithRows(['r1']);
  const result = mergeReportOps(base, [
    { t: 'meta', fields: { reportName: 'Новое имя' } },
  ]);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.doc.reportName, 'Новое имя');
});

test('answer.setMedia заменяет список media строки', () => {
  const base = docWithRows(['r1']);
  const result = applyOps(base, [
    {
      t: 'answer.setMedia',
      qid: 'q1',
      rid: 'r1',
      media: [{ serverFileId: 'f-1', name: 'photo.jpg', type: 'image/jpeg' }],
    },
  ]);
  assert.strictEqual(result.conflicts.length, 0);
  const media = result.doc.answers.q1[0].markers.media;
  assert.strictEqual(media.length, 1);
  assert.strictEqual(media[0].serverFileId, 'f-1');
  // Legacy-зеркало тоже обновлено.
  assert.strictEqual(result.doc.markers['0'][0].media[0].serverFileId, 'f-1');
});

test('answer.setMarkers сохраняет метку «Внимание» и видна другому клиенту', () => {
  const base = docWithRows(['r1']);

  // Пользователь A пометил строку «Внимание».
  const afterA = applyOps(base, [
    { t: 'answer.setMarkers', qid: 'q1', rid: 'r1', markers: { attention: true, needsWork: false } },
  ]);
  assert.strictEqual(afterA.conflicts.length, 0);
  assert.strictEqual(afterA.doc.answers.q1[0].markers.attention, true);
  // Legacy-зеркало тоже обновлено — метку увидит любой клиент.
  assert.strictEqual(afterA.doc.markers['0'][0].attention, true);

  // Пользователь B синхронизирует свою (немую по меткам) правку текста —
  // метка «Внимание» не должна затереться.
  const afterB = applyOps(afterA.doc, [
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'r1',
      lang: 'RU',
      baseText: '',
      baseUpdatedAt: 1,
      fields: { text: 'ответ B', isEmpty: false, updatedAt: 9 },
    },
  ]);
  assert.strictEqual(afterB.conflicts.length, 0);
  assert.strictEqual(afterB.doc.answers.q1[0].markers.attention, true);
  assert.strictEqual(afterB.doc.markers['0'][0].attention, true);
});

test('answer.setMarkers снимает метку «Внимание»', () => {
  const base = docWithRows(['r1']);
  base.answers.q1[0].markers = { attention: true, media: [], needsWork: false };

  const result = applyOps(base, [
    { t: 'answer.setMarkers', qid: 'q1', rid: 'r1', markers: { attention: false } },
  ]);
  assert.strictEqual(result.conflicts.length, 0);
  assert.strictEqual(result.doc.answers.q1[0].markers.attention, false);
  assert.strictEqual(result.doc.markers['0'][0].attention, false);
});

test('mergeReportOps: метка «Внимание» доходит до всех клиентов (canonical + legacy + JSON)', () => {
  // Документ «как лежит в БД»: canonical answers + legacy-зеркала. Клиенты
  // читают метку из legacy-зеркала markers (см. Report.fromJson).
  const stored = {
    schemaVersion: 2,
    reportName: 'Report',
    availableLanguages: ['RU'],
    currentLanguage: 'RU',
    questions: [{ id: 0, qid: 'q1', localizations: {} }],
    answers: {
      q1: [
        {
          rid: 'r1',
          legacyIndex: 0,
          localizations: {
            RU: { id: 'c1', text: 'ответ', isEmpty: false, createdAt: 1, updatedAt: 1 },
          },
          markers: { attention: false, needsWork: false, rowId: 'r1', media: [] },
        },
      ],
    },
    translations: {
      0: { RU: [{ id: 'c1', text: 'ответ', _empty: false, createdAt: 1, updatedAt: 1, rowId: 'r1' }] },
    },
    markers: { 0: [{ attention: false, needsWork: false, rowId: 'r1', media: [] }] },
  };

  // Пользователь A помечает строку «Внимание» и синхронизирует.
  const merged = mergeReportOps(stored, [
    { t: 'answer.setMarkers', qid: 'q1', rid: 'r1', markers: { attention: true, needsWork: false } },
  ]);

  assert.strictEqual(merged.conflicts.length, 0);
  assert.strictEqual(merged.doc.answers.q1[0].markers.attention, true);
  // Именно это представление читает клиент при pull.
  assert.strictEqual(merged.doc.markers['0'][0].attention, true);

  // Выдача по HTTP проходит через JSON — метка должна выжить и там.
  const roundTripped = JSON.parse(JSON.stringify(merged.doc));
  assert.strictEqual(roundTripped.answers.q1[0].markers.attention, true);
  assert.strictEqual(roundTripped.markers['0'][0].attention, true);
});

test('аудит authorId: сервер переопределяет автора ячеек (user:<id>)', () => {
  const base = docWithRows(['r1']);

  // Добавляем строку с «чужим» анонимным автором из клиента.
  const addResult = applyOps(
    base,
    [
      {
        t: 'answer.add',
        qid: 'q1',
        rid: 'r2',
        afterRid: 'r1',
        row: {
          rid: 'r2',
          legacyIndex: 1,
          localizations: {
            RU: {
              id: 'c2',
              text: 'добавлено',
              isEmpty: false,
              authorId: 'anon:fake',
              authorIsAnonymous: true,
              createdAt: 1,
              updatedAt: 2,
            },
          },
        },
      },
    ],
    { authorId: 'user:7' }
  );

  assert.strictEqual(addResult.conflicts.length, 0);
  const newCell = addResult.doc.answers.q1[1].localizations.RU;
  assert.strictEqual(newCell.authorId, 'user:7');
  assert.strictEqual(newCell.authorIsAnonymous, false);

  // Изменение ячейки тоже приписывается текущему пользователю.
  const updResult = applyOps(
    addResult.doc,
    [
      {
        t: 'answer.update',
        qid: 'q1',
        rid: 'r1',
        lang: 'RU',
        baseUpdatedAt: 1,
        fields: { text: 'изменено', updatedAt: 3 },
      },
    ],
    { authorId: 'user:8' }
  );
  assert.strictEqual(updResult.conflicts.length, 0);
  assert.strictEqual(
    updResult.doc.answers.q1[0].localizations.RU.authorId,
    'user:8'
  );
});

test('dedup вопросов: два клиента мигрируют legacy — второй вопрос не дублируется', () => {
  const serverDoc = docWithRows(['r1']);
  serverDoc.questions[0].localizations = {
    RU: { name: 'Вопрос про качество', description: '', example: '' },
  };
  serverDoc.answers.q1[0].localizations.RU.text = 'привет';
  serverDoc.answers.q1[0].localizations.RU.updatedAt = 1;

  // Клиент мигрировал тот же legacy-документ: свой qid/rid, но legacyId совпадает.
  const result = applyOps(serverDoc, [
    {
      t: 'question.add',
      qid: 'qx-client',
      afterQid: null,
      id: 0,
      legacyId: 0,
      question: {
        id: 0,
        legacyId: 0,
        localizations: {
          RU: { name: 'Вопрос про качество', description: '', example: '' },
        },
      },
    },
    {
      t: 'answer.add',
      qid: 'qx-client',
      rid: 'rx-client',
      afterRid: null,
      row: {
        rid: 'rx-client',
        legacyIndex: 0,
        localizations: {
          RU: { id: 'c', text: 'привет', isEmpty: false, createdAt: 5, updatedAt: 1, rowId: 'rx-client' },
        },
        markers: { attention: false, media: [], needsWork: false },
      },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 0);
  // Вопрос не продублирован, qid клиента алиасён на q1.
  assert.deepStrictEqual(result.doc.questions.map((q) => q.qid), ['q1']);
  // Строка не продублирована, текст/контент на месте.
  assert.deepStrictEqual(result.doc.answers.q1.map((r) => r.rid), ['r1']);
});

test('dedup параллельной миграции: одинаковый legacyIndex+fingerprint не дублируется', () => {
  const serverDoc = docWithRows(['r1']);
  serverDoc.answers.q1[0].localizations.RU.text = 'привет';
  serverDoc.answers.q1[0].localizations.RU.updatedAt = 1;

  // Клиент независимо мигрировал тот же legacy-документ и прислал свой rid.
  const clientRow = {
    rid: 'rx-client',
    legacyIndex: 0,
    localizations: {
      RU: {
        id: 'cell-x',
        text: 'привет',
        isEmpty: false,
        createdAt: 5,
        updatedAt: 1,
        rowId: 'rx-client',
      },
    },
    markers: { attention: false, media: [], needsWork: false },
  };

  const result = applyOps(serverDoc, [
    { t: 'answer.add', qid: 'q1', rid: 'rx-client', afterRid: null, row: clientRow },
    // Последующие ops от клиента продолжают ссылаться на его rid.
    {
      t: 'answer.update',
      qid: 'q1',
      rid: 'rx-client',
      lang: 'RU',
      baseUpdatedAt: 1,
      fields: { text: 'обновлено', updatedAt: 2 },
    },
  ]);

  assert.strictEqual(result.conflicts.length, 0);
  // Дубликат не создан: по-прежнему одна строка, alias привёл update к ней.
  assert.deepStrictEqual(result.doc.answers.q1.map((r) => r.rid), ['r1']);
  assert.strictEqual(result.doc.answers.q1[0].localizations.RU.text, 'обновлено');
});
