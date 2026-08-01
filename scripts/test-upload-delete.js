// ============================================================
// test-upload-delete.js — комплексная проверка загрузки/удаления
// файлов через API сервера и фактического наличия в KS3.
//
// Проверяет:
//   1. Серверная загрузка (POST /files/upload) + наличие в KS3
//   2. Presigned upload (прямая загрузка в KS3) + confirm
//   3. Удаление через DELETE /files/:id + факт удаления из KS3
//   4. Загрузка видео (.mp4) + проверка, что размер > 0
//
// Запуск: node scripts/test-upload-delete.js
// (сервер должен быть запущен на http://localhost:8000)
// ============================================================

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const ks3 = require('../src/services/ks3Storage');

const BASE = 'http://localhost:8000';
const TEST_USER = 'test_bot_' + Date.now();
const TEST_PASS = 'Test123456';

// Счётчики результатов
let passed = 0;
let failed = 0;
const results = [];

function ok(name, detail) {
  passed++;
  results.push(`  [PASS] ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`  \x1b[32m[PASS]\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
}
function fail(name, detail) {
  failed++;
  results.push(`  [FAIL] ${name}${detail ? ' — ' + detail : ''}`);
  console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}${detail ? ' — ' + detail : ''}`);
}
function section(name) {
  console.log('\n' + name);
  results.push('\n' + name);
}

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------

async function api(method, urlPath, { token, body } = {}) {
  const opts = { method, headers: {} };
  if (token) opts.headers['Authorization'] = 'Bearer ' + token;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + urlPath, opts);
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

async function multipartUpload(token, filePath, relativePath, reportId) {
  const buffer = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const formData = new FormData();
  formData.append('relativePath', relativePath);
  if (reportId) formData.append('reportId', String(reportId));
  formData.append('file', new Blob([buffer]), filename);

  const r = await fetch(BASE + '/files/upload', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + token },
    body: formData,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  return { status: r.status, json, text };
}

// ------------------------------------------------------------
// Прямая проверка KS3 через SDK (не через download service)
// ------------------------------------------------------------

async function checkKs3Exists(key) {
  try {
    const { data } = await ks3.getFile(key);
    return { exists: true, size: data ? data.length : 0 };
  } catch (err) {
    const msg = (err && err.message) ? err.message : String(err);
    const code = err && err.code;
    const status = err && err.statusCode;
    // 404 / NoSuchKey = файла нет
    if (msg.includes('404') || msg.includes('NoSuchKey') || code === 'NoSuchKey' || status === 404) {
      return { exists: false };
    }
    return { exists: null, error: msg, code, status };
  }
}

async function deleteKs3Direct(key) {
  try {
    await ks3.deleteFile(key);
    return true;
  } catch (err) {
    console.log(`    (KS3 direct delete failed: ${err.message})`);
    return false;
  }
}

// ============================================================
// Основной сценарий
// ============================================================

async function main() {
  console.log('========================================');
  console.log(' Тест загрузки/удаления файлов + KS3');
  console.log('========================================');
  console.log(`User: ${TEST_USER}`);
  console.log(`Server: ${BASE}`);

  // --- 1. Регистрация / логин ---
  section('1. Аутентификация');
  let token = null;
  let regRes = await api('POST', '/auth/register', {
    body: { username: TEST_USER, password: TEST_PASS },
  });
  if (regRes.status === 201 && regRes.json && regRes.json.token) {
    token = regRes.json.token;
    ok('Регистрация', `user=${TEST_USER}`);
  } else if (regRes.status === 409) {
    // Уже существует — пробуем логин
    const loginRes = await api('POST', '/auth/login', {
      body: { username: TEST_USER, password: TEST_PASS },
    });
    if (loginRes.status === 200 && loginRes.json && loginRes.json.token) {
      token = loginRes.json.token;
      ok('Логин (существующий пользователь)', `user=${TEST_USER}`);
    } else {
      fail('Логин', `status=${loginRes.status} ${loginRes.text.substring(0, 200)}`);
      return finish();
    }
  } else {
    fail('Регистрация', `status=${regRes.status} ${regRes.text.substring(0, 200)}`);
    return finish();
  }

  // --- 2. Создание отчёта ---
  section('2. Создание отчёта');
  let reportId = null;
  const reportRes = await api('POST', '/reports', {
    token,
    body: { title: 'Test Report', reportData: { test: true, items: [] } },
  });
  if (reportRes.status === 200 && reportRes.json && reportRes.json.report) {
    reportId = reportRes.json.report.id;
    ok('Создание отчёта', `id=${reportId}`);
  } else {
    fail('Создание отчёта', `status=${reportRes.status} ${reportRes.text.substring(0, 200)}`);
    return finish();
  }

  // Тестовые файлы
  const photoPath = path.join(__dirname, '..', '..', 'easy_tab', 'web', 'favicon.png');
  const videoPath = path.join(__dirname, 'test-sample.mp4');
  // Создаём тестовый "видео" файл (1KB псевдо-данных с mp4-заголовком)
  const videoHeader = Buffer.from([
    0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70, // ftyp box
    0x69, 0x73, 0x6f, 0x6d, 0x00, 0x00, 0x02, 0x00,
    0x69, 0x73, 0x6f, 0x6d, 0x69, 0x73, 0x6f, 0x32,
  ]);
  const videoBody = Buffer.alloc(1000, 0xAB); // 1KB данных
  fs.writeFileSync(videoPath, Buffer.concat([videoHeader, videoBody]));

  // ============================================================
  // ТЕСТ A: Серверная загрузка фото (multipart)
  // ============================================================
  section('ТЕСТ A: Серверная загрузка фото (POST /files/upload)');
  let fileA_id = null;
  let fileA_storageKey = null;

  const upA = await multipartUpload(token, photoPath, 'photos/test_photo.png', reportId);
  if (upA.status === 201 && upA.json && upA.json.success) {
    fileA_id = upA.json.file.id;
    ok('Загрузка фото', `fileId=${fileA_id}, size=${upA.json.file.size}, mime=${upA.json.file.mimeType}`);
  } else {
    fail('Загрузка фото', `status=${upA.status} ${upA.text.substring(0, 300)}`);
  }

  // Получаем storage_key через метаданные — controller не отдаёт storage_key,
  // но мы можем получить его через download URL или через прямой запрос к БД.
  // Используем getDownloadUrl — он вернёт URL, из которого можно извлечь ключ.
  if (fileA_id) {
    // Получаем storage_key через прямой вызов fileService (импортируем)
    const fileService = require('../src/services/fileService');
    const fileRec = await fileService.getFileById(fileA_id);
    if (fileRec) {
      fileA_storageKey = fileRec.storage_key;
      console.log(`    storage_key: ${fileA_storageKey}`);
    }
  }

  // Проверяем наличие в KS3
  if (fileA_storageKey) {
    const exists = await checkKs3Exists(fileA_storageKey);
    if (exists.exists === true) {
      ok('Фото в KS3 существует', `size=${exists.size} байт`);
      if (exists.size === 0) {
        fail('Фото пустое (0 байт)', 'файл существует, но размер 0');
      }
    } else if (exists.exists === false) {
      fail('Фото в KS3 отсутствует', 'файл должен быть после загрузки');
    } else {
      fail('Проверка фото в KS3', `error=${exists.error}`);
    }
  }

  // ============================================================
  // ТЕСТ B: Presigned upload (прямая загрузка в KS3)
  // ============================================================
  section('ТЕСТ B: Presigned upload (прямая загрузка в KS3)');
  let fileB_id = null;
  let fileB_storageKey = null;

  // 1. Запрашиваем presigned URL
  const presignRes = await api('POST', '/files/presign-upload', {
    token,
    body: { fileName: 'test_presign.png', relativePath: 'photos/test_presign.png', reportId },
  });
  let uploadUrl = null;
  if (presignRes.status === 200 && presignRes.json && presignRes.json.success) {
    uploadUrl = presignRes.json.uploadUrl;
    fileB_id = presignRes.json.fileId;
    fileB_storageKey = presignRes.json.storageKey;
    ok('Presigned URL получен', `fileId=${fileB_id}`);
  } else {
    fail('Presigned URL', `status=${presignRes.status} ${presignRes.text.substring(0, 300)}`);
  }

  // 2. PUT файл напрямую в KS3
  //    ВАЖНО: не отправляем Content-Type — presigned URL подписан без него.
  //    Отправка Content-Type приведёт к SignatureDoesNotMatch.
  //    (клиент upload_helper_web.dart тоже не отправляет Content-Type)
  if (uploadUrl) {
    const photoBuffer = fs.readFileSync(photoPath);
    const putRes = await fetch(uploadUrl, {
      method: 'PUT',
      body: photoBuffer,
    });
    if (putRes.status === 200) {
      ok('PUT в KS3 напрямую', `status=${putRes.status}`);
    } else {
      fail('PUT в KS3 напрямую', `status=${putRes.status}`);
      const putText = await putRes.text().catch(() => '');
      console.log(`    ответ: ${putText.substring(0, 300)}`);
    }
  }

  // 3. Проверяем наличие в KS3 до confirm
  if (fileB_storageKey) {
    const existsBefore = await checkKs3Exists(fileB_storageKey);
    if (existsBefore.exists === true) {
      ok('Объект в KS3 после PUT (до confirm)', `size=${existsBefore.size} байт`);
    } else {
      fail('Объект в KS3 после PUT (до confirm)', existsBefore.error || 'не найден');
    }
  }

  // 4. Confirm — создаём запись в БД
  if (fileB_id && fileB_storageKey) {
    const photoBuffer = fs.readFileSync(photoPath);
    const confirmRes = await api('POST', '/files/confirm-upload', {
      token,
      body: {
        fileId: fileB_id,
        storageKey: fileB_storageKey,
        fileName: 'test_presign.png',
        size: photoBuffer.length,
        mimeType: 'image/png',
        relPath: 'photos/test_presign.png',
        reportId,
      },
    });
    if (confirmRes.status === 201 && confirmRes.json && confirmRes.json.success) {
      ok('Confirm upload', `fileId=${confirmRes.json.file.id}`);
    } else {
      fail('Confirm upload', `status=${confirmRes.status} ${confirmRes.text.substring(0, 300)}`);
    }
  }

  // ============================================================
  // ТЕСТ C: Загрузка видео (.mp4)
  // ============================================================
  section('ТЕСТ C: Загрузка видео (POST /files/upload, .mp4)');
  let fileC_id = null;
  let fileC_storageKey = null;

  const upC = await multipartUpload(token, videoPath, 'photos/test_video.mp4', reportId);
  if (upC.status === 201 && upC.json && upC.json.success) {
    fileC_id = upC.json.file.id;
    ok('Загрузка видео', `fileId=${fileC_id}, size=${upC.json.file.size}, mime=${upC.json.file.mimeType}`);
  } else {
    fail('Загрузка видео', `status=${upC.status} ${upC.text.substring(0, 300)}`);
  }

  if (fileC_id) {
    const fileService = require('../src/services/fileService');
    const fileRec = await fileService.getFileById(fileC_id);
    if (fileRec) {
      fileC_storageKey = fileRec.storage_key;
      console.log(`    storage_key: ${fileC_storageKey}`);
    }
  }

  if (fileC_storageKey) {
    const exists = await checkKs3Exists(fileC_storageKey);
    if (exists.exists === true) {
      ok('Видео в KS3 существует', `size=${exists.size} байт`);
      if (exists.size === 0) {
        fail('Видео пустое (0 байт)', 'файл существует, но размер 0 — критично!');
      } else {
        ok('Видео не пустое', `size=${exists.size} > 0`);
      }
    } else if (exists.exists === false) {
      fail('Видео в KS3 отсутствует', 'файл должен быть после загрузки');
    } else {
      fail('Проверка видео в KS3', `error=${exists.error}`);
    }
  }

  // ============================================================
  // ТЕСТ D: Удаление фото (серверная загрузка) + проверка KS3
  // ============================================================
  section('ТЕСТ D: Удаление фото (DELETE /files/:id) + проверка KS3');
  if (fileA_id && fileA_storageKey) {
    const delRes = await api('DELETE', '/files/' + fileA_id, { token });
    if (delRes.status === 200 && delRes.json && delRes.json.success) {
      ok('DELETE фото API', `status=${delRes.status}`);
    } else {
      fail('DELETE фото API', `status=${delRes.status} ${delRes.text.substring(0, 300)}`);
    }

    // Проверяем, что запись в БД удалена
    const fileService = require('../src/services/fileService');
    const afterDel = await fileService.getFileById(fileA_id);
    if (!afterDel) {
      ok('Запись в БД удалена', `fileId=${fileA_id}`);
    } else {
      fail('Запись в БД осталась', `fileId=${fileA_id} всё ещё в БД`);
    }

    // Проверяем, что объект в KS3 удалён
    const ks3After = await checkKs3Exists(fileA_storageKey);
    if (ks3After.exists === false) {
      ok('Объект KS3 удалён', 'фото больше не в KS3');
    } else if (ks3After.exists === true) {
      fail('Объект KS3 остался', `фото всё ещё в KS3, size=${ks3After.size}`);
      // Очистка
      await deleteKs3Direct(fileA_storageKey);
    } else {
      fail('Проверка удаления KS3', `error=${ks3After.error}`);
    }
  } else {
    fail('ТЕСТ D пропущен', 'нет загруженного фото');
  }

  // ============================================================
  // ТЕСТ E: Удаление видео + проверка KS3
  // ============================================================
  section('ТЕСТ E: Удаление видео (DELETE /files/:id) + проверка KS3');
  if (fileC_id && fileC_storageKey) {
    const delRes = await api('DELETE', '/files/' + fileC_id, { token });
    if (delRes.status === 200 && delRes.json && delRes.json.success) {
      ok('DELETE видео API', `status=${delRes.status}`);
    } else {
      fail('DELETE видео API', `status=${delRes.status} ${delRes.text.substring(0, 300)}`);
    }

    const fileService = require('../src/services/fileService');
    const afterDel = await fileService.getFileById(fileC_id);
    if (!afterDel) {
      ok('Запись в БД удалена', `fileId=${fileC_id}`);
    } else {
      fail('Запись в БД осталась', `fileId=${fileC_id} всё ещё в БД`);
    }

    const ks3After = await checkKs3Exists(fileC_storageKey);
    if (ks3After.exists === false) {
      ok('Объект KS3 удалён', 'видео больше не в KS3');
    } else if (ks3After.exists === true) {
      fail('Объект KS3 остался', `видео всё ещё в KS3, size=${ks3After.size}`);
      await deleteKs3Direct(fileC_storageKey);
    } else {
      fail('Проверка удаления KS3', `error=${ks3After.error}`);
    }
  } else {
    fail('ТЕСТ E пропущен', 'нет загруженного видео');
  }

  // ============================================================
  // ТЕСТ F: Удаление presigned-файла + проверка KS3
  // ============================================================
  section('ТЕСТ F: Удаление presigned-файла (DELETE) + проверка KS3');
  if (fileB_id && fileB_storageKey) {
    const delRes = await api('DELETE', '/files/' + fileB_id, { token });
    if (delRes.status === 200 && delRes.json && delRes.json.success) {
      ok('DELETE presigned API', `status=${delRes.status}`);
    } else {
      fail('DELETE presigned API', `status=${delRes.status} ${delRes.text.substring(0, 300)}`);
    }

    const fileService = require('../src/services/fileService');
    const afterDel = await fileService.getFileById(fileB_id);
    if (!afterDel) {
      ok('Запись в БД удалена', `fileId=${fileB_id}`);
    } else {
      fail('Запись в БД осталась', `fileId=${fileB_id} всё ещё в БД`);
    }

    const ks3After = await checkKs3Exists(fileB_storageKey);
    if (ks3After.exists === false) {
      ok('Объект KS3 удалён', 'presigned файл больше не в KS3');
    } else if (ks3After.exists === true) {
      fail('Объект KS3 остался', `presigned файл всё ещё в KS3, size=${ks3After.size}`);
      await deleteKs3Direct(fileB_storageKey);
    } else {
      fail('Проверка удаления KS3', `error=${ks3After.error}`);
    }
  } else {
    fail('ТЕСТ F пропущен', 'нет presigned-файла');
  }

  // ============================================================
  // ТЕСТ G: DELETE с Content-Type: application/json (регрессия 400)
  // ============================================================
  section('ТЕСТ G: DELETE с Content-Type (регрессия ошибки 400)');
  {
    // Загружаем временный файл, затем удаляем с Content-Type
    const upG = await multipartUpload(token, photoPath, 'photos/test_g.png', reportId);
    if (upG.status === 201 && upG.json && upG.json.file) {
      const gId = upG.json.file.id;
      const fileService = require('../src/services/fileService');
      const gRec = await fileService.getFileById(gId);
      const gKey = gRec ? gRec.storage_key : null;

      // DELETE с Content-Type: application/json (старый баг)
      const delG = await fetch(BASE + '/files/' + gId, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'application/json',
        },
      });
      if (delG.status === 200) {
        ok('DELETE с Content-Type: application/json', `status=${delG.status} (не 400!)`);
      } else {
        const t = await delG.text().catch(() => '');
        fail('DELETE с Content-Type', `status=${delG.status} ${t.substring(0, 200)}`);
      }

      // Проверяем KS3
      if (gKey) {
        const ks3G = await checkKs3Exists(gKey);
        if (ks3G.exists === false) {
          ok('Объект KS3 удалён (после DELETE с Content-Type)', '');
        } else if (ks3G.exists === true) {
          fail('Объект KS3 остался', `size=${ks3G.size}`);
          await deleteKs3Direct(gKey);
        }
      }
    } else {
      fail('ТЕСТ G: загрузка', `status=${upG.status}`);
    }
  }

  // --- Очистка: удаляем отчёт ---
  section('Очистка');
  const delReportRes = await api('DELETE', '/reports/' + reportId, { token });
  if (delReportRes.status === 200) {
    ok('Удаление тестового отчёта', `id=${reportId}`);
  } else {
    fail('Удаление тестового отчёта', `status=${delReportRes.status}`);
  }

  // Удаляем тестовый видео-файл
  try { fs.unlinkSync(videoPath); } catch (_) {}

  finish();
}

function finish() {
  console.log('\n========================================');
  console.log(` ИТОГ: ${passed} passed, ${failed} failed`);
  console.log('========================================\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
