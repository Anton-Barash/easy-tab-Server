// ============================================================
// HTML Generator — генерация HTML-отчёта из JSON на сервере.
//
// Порт _generateHtml() из easy_tab/lib/providers/report_provider.dart.
// Вместо локальных путей вида "photos/f1.jpg" использует подписанные
// presigned URL из KS3. Если для медиа нет готового URL — fallback
// на серверный прокси /view/report/:id/files/...
//
// Безопасность:
//   - Все пользовательские данные экранируются (escapeHtml)
//   - KS3-ключи не раскрываются клиенту (только подписанные URL)
// ============================================================

const logger = require('../utils/logger');

// ------------------------------------------------------------
// Константы (синхронизированы с Dart-кодом)
// ------------------------------------------------------------

const MAX_LANGUAGES = 5;
const LANGUAGE_PRIORITY = { RU: 0, EN: 1, ZH: 2 };

const LANGUAGE_COLORS = {
  1: '#888888',
  2: '#27ae60',
  3: '#8e44ad',
  4: '#2c7da0',
};

// ------------------------------------------------------------
// Утилиты
// ------------------------------------------------------------

/**
 * Экранирует HTML-спецсимволы (защита от XSS).
 * Синхронизировано с escapeHtml() из Dart.
 */
function escapeHtml(input) {
  if (input == null) return '';
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Экранирует HTML + сохраняет переносы строк как <br>.
 */
function escapeHtmlWithBr(input) {
  return escapeHtml(input).replace(/\n/g, '<br>');
}

/**
 * Сортирует языки по приоритету (RU, EN, ZH...), лимит MAX_LANGUAGES.
 */
function sortLanguages(languages) {
  const sorted = [...languages];
  sorted.sort((a, b) => {
    const pa = LANGUAGE_PRIORITY[a] ?? 999;
    const pb = LANGUAGE_PRIORITY[b] ?? 999;
    if (pa !== pb) return pa - pb;
    return a.localeCompare(b);
  });
  return sorted.slice(0, MAX_LANGUAGES);
}

/**
 * Форматирует timestamp (мс) в строку даты-времени "YYYY-MM-DD HH:MM".
 */
function formatDateTime(timestampMs) {
  const d = new Date(timestampMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`;
}

/**
 * Форматирует timestamp (мс) в дату "DD.MM.YYYY".
 */
function formatDate(timestampMs) {
  const d = new Date(timestampMs);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy}`;
}

/**
 * Получить ответы для вопроса по языку.
 * Порт Report.getAnswersForQuestion() из Dart.
 *
 * Объединяет translations (текст) и markers (медиа, attention, needsWork)
 * по индексу.
 */
function getAnswersForQuestion(report, questionIndex, langCode) {
  const qid = String(questionIndex);
  const langAnswers = report.translations?.[qid]?.[langCode] ?? [];
  const langMarkers = report.markers?.[qid] ?? [];

  const maxLen = Math.max(langAnswers.length, langMarkers.length);
  const result = [];

  for (let i = 0; i < maxLen; i++) {
    const answer = i < langAnswers.length ? langAnswers[i] : null;
    const marker = i < langMarkers.length ? langMarkers[i] : null;

    const text = answer ? (answer.text ?? '') : '';
    const isEmpty = !answer || answer._empty === true;
    const attention = marker ? (marker.attention ?? false) : false;
    const needsWork = marker ? (marker.needsWork ?? false) : false;
    const mediaList = marker ? (marker.media ?? []) : [];

    // Вычисляем relativePath для каждого медиа (как в _generateHtml)
    const mediaMaps = mediaList.map((m) => {
      const relativePath = m.attention === true
        ? `X/${m.name}`
        : `photos/${m.name}`;
      return {
        name: m.name,
        type: m.type ?? 'image/jpeg',
        attention: m.attention ?? false,
        originalName: m.originalName ?? '',
        localPath: relativePath,
      };
    });

    result.push({
      text,
      isEmpty,
      attention,
      needsWork,
      media: mediaMaps,
    });
  }

  return result;
}

/**
 * Получить отображаемое имя вопроса для языка.
 * Порт Question.getDisplayName() из Dart.
 */
function getQuestionDisplayName(question, langCode, questionIndex) {
  const loc = question.localizations?.[langCode];
  if (loc?.name && loc.name.length > 0) return loc.name;
  // Fallback: ищем в других языках
  for (const [lang, l] of Object.entries(question.localizations ?? {})) {
    if (l.name && l.name.length > 0) return l.name;
  }
  return `Вопрос ${questionIndex + 1}`;
}

// ------------------------------------------------------------
// Основная функция генерации HTML
// ------------------------------------------------------------

/**
 * Сгенерировать HTML-отчёт из JSON данных.
 *
 * @param {object} reportData - JSON-объект отчёта (Report.toJson())
 * @param {number} reportId - ID отчёта (для формирования fallback proxy-путей)
 * @param {string|null} token - JWT-токен (добавляется в URL fallback proxy для приватных отчётов)
 * @param {string} [baseUrl] - базовый URL сервера для абсолютных fallback URL
 * @param {Object} [mediaUrls] - { 'photos/f1.jpg': { full, thumb }, ... } presigned URL из KS3
 * @param {string} [ks3Folder] - папка отчёта в KS3 (не используется напрямую, оставлена для совместимости)
 * @returns {string} HTML-страница
 */
function generateReportHtml(reportData, reportId, token, baseUrl, mediaUrls, ks3Folder) {
  if (!reportData) {
    return '<html><body>Нет отчёта</body></html>';
  }

  // Формирует presigned/full URL для медиа. Если готового URL нет — fallback на proxy.
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';
  function resolveMediaUrls(localPath, mediaName) {
    const key = localPath || mediaName;
    if (mediaUrls && mediaUrls[key]) {
      return mediaUrls[key];
    }
    const proxyBase = baseUrl
      ? `${baseUrl}/view/report/${reportId}`
      : `/view/report/${reportId}`;
    const full = `${proxyBase}/files/${localPath}${tokenSuffix}`;
    const thumb = `${proxyBase}/thumbnails/${localPath}${tokenSuffix}`;
    return { full, thumb };
  }

  const reportName = escapeHtml(reportData.reportName ?? '');
  const dateTime = formatDateTime(reportData.timestamp ?? Date.now());
  const allLanguages = reportData.availableLanguages ?? [];
  const languages = sortLanguages(allLanguages);

  // Собираем медиа по вопросам/ответам/языкам (как в _generateHtml)
  const allMediaByQandAandLang = [];
  const allImagePaths = [];

  for (let i = 0; i < (reportData.questions ?? []).length; i++) {
    const questionMedia = [];
    for (let li = 0; li < languages.length; li++) {
      const lang = languages[li];
      const answers = getAnswersForQuestion(reportData, i, lang);
      const langMedia = [];
      for (const a of answers) {
        langMedia.push(a.media);
        for (const m of a.media) {
          if (m.type.startsWith('image') && !allImagePaths.includes(m.localPath)) {
            allImagePaths.push(m.localPath);
          }
        }
      }
      questionMedia.push(langMedia);
    }
    allMediaByQandAandLang.push(questionMedia);
  }

  const buf = [];

  // === HTML HEAD + CSS ===
  buf.push('<!DOCTYPE html>');
  buf.push('<html lang="ru">');
  buf.push('<head>');
  buf.push('  <meta charset="UTF-8">');
  buf.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
  buf.push(`  <title>${reportName} - Excel таблица</title>`);
  buf.push('  <style>');
  buf.push('    * { margin: 0; padding: 0; box-sizing: border-box; }');
  buf.push('    body { font-family: \'Segoe UI\', \'Calibri\', \'Arial\', sans-serif; background: #e9e9e9; }');
  buf.push('    .language-switcher { position: sticky; top: 0; background: #e9e9e9; display: flex; gap: 10px; flex-wrap: wrap; }');
  buf.push('    .lang-btn { padding: 4px 8px; border: 1px solid #a0a0a0; background: white; cursor: pointer; font-size: 7px; border-radius: 4px; }');
  buf.push('    .lang-btn.active { background: #00B0F0; color: white; border-color: #00B0F0; }');
  buf.push('    .excel-wrapper { background: white; border: 1px solid #a0a0a0; display: block; width: fit-content; box-shadow: 2px 2px 8px rgba(0,0,0,0.1); margin: 20px auto; }');
  buf.push('    table { border-collapse: collapse; font-size: 16px; table-layout: auto; }');
  buf.push('    th, td { padding: 7.5px 12.5px; vertical-align: top; border-bottom: 1px solid #d0d0d0; }');
  buf.push('    th { background: #f3f3f3; font-weight: 600; text-align: left; color: #2c2c2c; }');
  buf.push('    .media-thumbnails { display: flex; flex-wrap: wrap; gap: 4px; }');
  buf.push('    .media-item { width: 50px; height: 50px; cursor: pointer; }');
  buf.push('    .media-item-more { background: #c0c0c0; border: 1px solid #a0a0a0; display: flex; align-items: center; justify-content: center; }');
  buf.push('    .media-item-more:hover { background: #b0b0b0; }');
  buf.push('    .media-more { font-size: 20px; font-weight: bold; color: #333; }');
  buf.push('    .media-thumbnail { width: 50px; height: 50px; object-fit: cover; border-radius: 4px; border: 1px solid #d0d0d0; cursor: pointer; background: #f0f0f0; }');
  buf.push('    .media-thumbnail.loading { background: linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%); background-size: 200% 100%; animation: loading 1.5s ease-in-out infinite; }');
  buf.push('    @keyframes loading { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }');
  buf.push('    .media-hidden { display: none; }');
  // Lightbox
  buf.push('    .lightbox { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.9); display: none; flex-direction: column; align-items: center; justify-content: center; z-index: 9999; }');
  buf.push('    .lightbox.active { display: flex; }');
  buf.push('    .lightbox-controls { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); display: flex; gap: 10px; z-index: 10002; }');
  buf.push('    .lightbox-controls button { background: rgba(255,255,255,0.2); border: none; color: white; padding: 10px 15px; border-radius: 4px; cursor: pointer; font-size: 16px; transition: background 0.2s; }');
  buf.push('    .lightbox-controls button:hover { background: rgba(255,255,255,0.3); }');
  buf.push('    .lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.2); border: none; color: white; padding: 15px 20px; border-radius: 4px; cursor: pointer; font-size: 20px; transition: background 0.2s; z-index: 10001; }');
  buf.push('    .lightbox-nav:hover { background: rgba(255,255,255,0.3); }');
  buf.push('    .lightbox-nav.prev { left: calc(50% - 500px); }');
  buf.push('    .lightbox-nav.next { right: calc(50% - 500px); }');
  buf.push('    .lightbox-close { position: absolute; top: 20px; right: 20px; background: none; border: none; color: white; font-size: 32px; cursor: pointer; z-index: 10002; }');
  buf.push('    .lightbox-info { position: absolute; top: 0px; left: 0px; background: rgba(0,0,0,0.7); color: white; padding: 15px 20px; border-radius: 8px; max-width: 280px; overflow-y: auto; text-align: left; z-index: 10001; }');
  buf.push('    .attention-answer { color: #f69a15; }');
  buf.push('    .lightbox-question { font-weight: bold; font-size: 16px; margin-bottom: 5px; }');
  buf.push('    .lightbox-answer { font-size: 14px; }');
  buf.push('    .lightbox-image-container { position: relative; width: 100%; overflow: hidden; cursor: grab; display: flex; align-items: center; justify-content: center; z-index: 10000; }');
  buf.push('    .lightbox-image-container.dragging { cursor: grabbing; }');
  buf.push('    .lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center; }');
  buf.push('    .lightbox-thumbnails-bar { position: absolute; bottom: 0px; left: 50%; transform: translateX(-50%); background: rgba(0,0,0,0.7); padding: 10px 15px; border-radius: 8px; max-width: 80%; overflow: hidden; z-index: 10001; }');
  buf.push('    @media (max-width: 1000px) { .lightbox-nav.prev { left: 20px; } .lightbox-nav.next { right: 20px; } .lightbox-image-container { width: 90%; } }');
  buf.push('    @media (max-width: 768px) { .lightbox-info { left: 20px; right: 20px; top: 60px; bottom: auto; max-width: none; max-height: 100px; } .lightbox-image-container { position: relative; width: calc(100% - 40px); height: calc(100vh - 290px); } .lightbox-nav.prev { left: 20px; } .lightbox-nav.next { right: 20px; } .lightbox-thumbnails-bar { bottom: 120px; } }');
  buf.push('    .thumbnails-container { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.5) rgba(0,0,0,0.3); }');
  buf.push('    .thumbnails-container::-webkit-scrollbar { height: 6px; }');
  buf.push('    .thumbnails-container::-webkit-scrollbar-track { background: rgba(255,255,255,0.1); border-radius: 3px; }');
  buf.push('    .thumbnails-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.5); border-radius: 3px; }');
  buf.push('    .lightbox-thumbnail { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; cursor: pointer; opacity: 0.6; transition: opacity 0.2s, border 0.2s; border: 2px solid transparent; }');
  buf.push('    .lightbox-thumbnail:hover { opacity: 1; }');
  buf.push('    .lightbox-thumbnail.active { opacity: 1; border-color: #00B0F0; }');
  buf.push('    .lightbox-grid-btn { position: absolute; top: 20px; right: 70px; background: rgba(255,255,255,0.2); border: none; color: white; font-size: 24px; cursor: pointer; z-index: 10002; padding: 5px 12px; border-radius: 4px; transition: background 0.2s; }');
  buf.push('    .lightbox-grid-btn:hover { background: rgba(255,255,255,0.3); }');
  // Gallery
  buf.push('    .gallery-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); display: none; flex-direction: column; z-index: 9998; }');
  buf.push('    .gallery-overlay.active { display: flex; }');
  buf.push('    .gallery-close { position: absolute; top: 20px; right: 20px; background: none; border: none; color: white; font-size: 32px; cursor: pointer; z-index: 10002; }');
  buf.push('    .gallery-container { flex: 1; overflow-y: auto; padding: 80px 20px 20px; }');
  buf.push('    .gallery-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; max-width: 1400px; margin: 0 auto; }');
  buf.push('    .gallery-item { aspect-ratio: 1; overflow: hidden; border-radius: 8px; cursor: pointer; transition: transform 0.2s; }');
  buf.push('    .gallery-item:hover { transform: scale(1.02); }');
  buf.push('    .gallery-item img { width: 100%; height: 100%; object-fit: cover; }');
  buf.push('    @media (max-width: 1200px) { .gallery-grid { grid-template-columns: repeat(3, 1fr); } }');
  buf.push('    @media (max-width: 900px) { .gallery-grid { grid-template-columns: repeat(2, 1fr); } }');
  buf.push('    @media (max-width: 600px) { .gallery-grid { grid-template-columns: 1fr; } }');
  buf.push('    .gallery-section { margin-bottom: 30px; display: grid; grid-template-columns: inherit; }');
  buf.push('    .gallery-section-header { grid-column: 1 / -1; color: white; padding: 15px 20px; border-radius: 8px; margin-bottom: 15px; font-size: 16px; font-weight: 600; }');
  buf.push('    .gallery-section-header .question { font-size: 14px; opacity: 0.9; margin-bottom: 5px; }');
  buf.push('    .gallery-section-header .answer { font-size: 18px; font-weight: 700; }');
  // Header
  buf.push('    .header-row { background: #ffffff !important; color: #6c757d; text-align: left; }');
  buf.push('    .title { font-weight: bold; font-size: 22px; }');
  buf.push('    .border-bold { border-bottom: 2px solid #6c757d !important; font-size: 22px; }');
  buf.push('    .no-border { border-bottom: none !important; font-size: 18px; }');
  buf.push('  </style>');
  buf.push('</head>');
  buf.push('<body>');

  // === Language switcher ===
  buf.push('<div class="language-switcher">');
  for (let li = 0; li < languages.length; li++) {
    const lang = languages[li];
    buf.push(`  <button class="lang-btn ${li === 0 ? 'active' : ''}" data-lang="${li}" onclick="switchLanguage(${li})">${escapeHtml(lang)}</button>`);
  }
  buf.push('</div>');

  // === Date ===
  const currentDate = formatDate(Date.now());
  const displayDate = reportData.dateTimestamp
    ? formatDate(reportData.dateTimestamp)
    : currentDate;

  // === Table header ===
  buf.push('<div class="excel-wrapper">');
  buf.push('  <table>');
  buf.push('    <tr class="header-row">');
  buf.push('      <td class="border-bold"></td>');
  buf.push(`      <td class="title border-bold">${escapeHtml(reportData.productType ?? '')}</td>`);
  buf.push('      <td class="border-bold"></td>');
  buf.push('      <td class="border-bold">Фабрика</td>');
  buf.push('      <td class="border-bold">Модель</td>');
  buf.push('    </tr>');
  buf.push('    <tr class="header-row">');
  buf.push('      <td class="no-border"></td>');
  buf.push(`      <td class="no-border">${displayDate}</td>`);
  buf.push('      <td class="no-border"></td>');
  buf.push(`      <td class="no-border">${escapeHtml(reportData.factory ?? '')}</td>`);
  buf.push(`      <td class="no-border">${escapeHtml(reportData.model ?? '')}</td>`);
  buf.push('    </tr>');
  buf.push('    <tr class="header-row">');
  buf.push('      <td colspan="5" style="text-align:left; font-weight:bold; padding:8px; color:#6c757d; border-bottom:none;">ФОТО</td>');
  buf.push('    </tr>');
  buf.push('    <tr>');
  buf.push(`      <th colspan="5">${reportName} | ${dateTime}</th>`);
  buf.push('    </tr>');

  // === Table body: questions and answers ===
  const questions = reportData.questions ?? [];
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const questionNames = [];
    for (let li = 0; li < languages.length; li++) {
      const lang = languages[li];
      const loc = q.localizations?.[lang];
      questionNames.push(escapeHtml(loc?.name ?? getQuestionDisplayName(q, lang, i)));
    }

    // Answers by language
    const answersByLang = [];
    for (let li = 0; li < languages.length; li++) {
      answersByLang.push(getAnswersForQuestion(reportData, i, languages[li]));
    }

    const maxAnswers = answersByLang.reduce((mx, a) => Math.max(mx, a.length), 0);

    // Check attention per answer
    const answerHasAttention = [];
    for (let ai = 0; ai < maxAnswers; ai++) {
      let hasAtt = false;
      for (let li = 0; li < languages.length; li++) {
        if (ai < answersByLang[li].length && answersByLang[li][ai].attention === true) {
          hasAtt = true;
        }
      }
      answerHasAttention.push(hasAtt);
    }

    // Generate rows
    for (let ai = 0; ai < maxAnswers; ai++) {
      buf.push('    <tr>');

      // Number cell
      if (ai === 0) {
        buf.push(`      <td style="background:#fafafa;font-weight:500;width:40px;color:#00B0F0;">${i + 1}</td>`);
      } else {
        buf.push('      <td style="background:#fafafa;width:40px;"></td>');
      }

      // Question cell
      if (ai === 0) {
        const qParts = [];
        for (let li = 0; li < languages.length; li++) {
          const style = li === 0 ? '' : 'display:none;';
          qParts.push(`<span class="question-lang-${li}" style="${style}">${questionNames[li]}</span>`);
        }
        buf.push(`      <td style="background:#fafafa;font-weight:500;width:200px;">${qParts.join('')}</td>`);
      } else {
        buf.push('      <td style="background:#fafafa;width:200px;"></td>');
      }

      // Attention cell
      if (answerHasAttention[ai]) {
        buf.push('      <td style="text-align:center;vertical-align:middle;width:30px;background:#fff3cd;"><span style="font-weight:bold;color:#ef4444;">!</span></td>');
      } else {
        buf.push('      <td style="text-align:center;vertical-align:middle;width:30px;"></td>');
      }

      // Answer text cell
      const aParts = [];
      for (let li = 0; li < languages.length; li++) {
        const style = li === 0 ? '' : 'display:none;';
        let content = '';
        if (ai < answersByLang[li].length) {
          content = escapeHtmlWithBr(answersByLang[li][ai].text ?? '');
        }
        aParts.push(`<span class="answer-lang-${li}" style="${style}">${content}</span>`);
      }
      const answerBg = answerHasAttention[ai] ? '#fff3cd' : 'white';
      buf.push(`      <td style="background:${answerBg};width:375px;">${aParts.join('')}</td>`);

      // Media cell
      const mParts = [];
      for (let li = 0; li < languages.length; li++) {
        const style = li === 0 ? '' : 'display:none;';
        mParts.push(`<span class="media-lang-${li}" style="${style}">${mediaCellContent(ai, li, i, allMediaByQandAandLang, questionNames, answersByLang, resolveMediaUrls)}</span>`);
      }
      buf.push(`      <td style="background:#fafafa;width:200px;">${mParts.join('')}</td>`);


      buf.push('    </tr>');
    }
  }

  buf.push('  </table>');
  buf.push('</div>');

  // === Lightbox HTML ===
  buf.push('  <div class="lightbox" id="lightbox">');
  buf.push('    <button class="lightbox-close" onclick="closeLightbox()">×</button>');
  buf.push('    <button class="lightbox-grid-btn" onclick="openGallery()" title="Просмотр всех фото">⊞</button>');
  buf.push('    <div class="lightbox-info">');
  buf.push('      <div class="lightbox-question" id="lightbox-question"></div>');
  buf.push('      <div class="lightbox-answer" id="lightbox-answer"></div>');
  buf.push('    </div>');
  buf.push('    <div class="lightbox-controls">');
  buf.push('      <button onclick="zoomIn()">+</button>');
  buf.push('      <button onclick="zoomOut()">-</button>');
  buf.push('      <button onclick="resetZoom()">100%</button>');
  buf.push('    </div>');
  buf.push('    <button class="lightbox-nav prev" onclick="prevMedia()">←</button>');
  buf.push('    <div class="lightbox-image-container" id="lightbox-container">');
  buf.push('      <img id="lightbox-img" src="" alt="" style="display:none;" />');
  buf.push('      <video id="lightbox-video" controls autoplay playsinline style="display:none;max-width:100%;max-height:100%;object-fit:contain;"></video>');
  buf.push('    </div>');
  buf.push('    <button class="lightbox-nav next" onclick="nextMedia()">→</button>');
  buf.push('    <div class="lightbox-thumbnails-bar" id="lightbox-thumbnails-bar">');
  buf.push('      <div class="thumbnails-container" id="thumbnails-container"></div>');
  buf.push('    </div>');
  buf.push('  </div>');

  // === Gallery overlay ===
  buf.push('  <div class="gallery-overlay" id="gallery-overlay">');
  buf.push('    <button class="gallery-close" onclick="closeGallery()">×</button>');
  buf.push('    <div class="gallery-container" id="gallery-container">');
  buf.push('      <div class="gallery-grid" id="gallery-grid"></div>');
  buf.push('    </div>');
  buf.push('  </div>');

  // === JavaScript ===
  buf.push('<script>');
  buf.push('    let currentIndex = 0;');
  buf.push('    let media = [];');
  buf.push('    let scale = 1;');
  buf.push('    let panX = 0;');
  buf.push('    let panY = 0;');
  buf.push('    let isDragging = false;');
  buf.push('    let startX = 0;');
  buf.push('    let startY = 0;');
  buf.push(`    const allLanguages = ${JSON.stringify(languages)};`);
  buf.push('    let currentLanguage = 0;');

  buf.push('    function switchLanguage(li) {');
  buf.push('      document.querySelectorAll(".lang-btn").forEach(btn => btn.classList.remove("active"));');
  buf.push('      document.querySelector(\'.lang-btn[data-lang="\' + li + \'"]\').classList.add("active");');
  buf.push('      for (let l = 0; l < allLanguages.length; l++) {');
  buf.push('        const display = l === li ? "" : "none";');
  buf.push('        document.querySelectorAll(".question-lang-" + l).forEach(el => el.style.display = display);');
  buf.push('        document.querySelectorAll(".answer-lang-" + l).forEach(el => el.style.display = display);');
  buf.push('        document.querySelectorAll(".media-lang-" + l).forEach(el => el.style.display = display);');
  buf.push('      }');
  buf.push('      currentLanguage = li;');
  buf.push('      loadMediaByLanguage();');
  buf.push('    }');

  buf.push('    function loadMediaByLanguage() {');
  buf.push('      const mediaElements = document.querySelectorAll(".media-item");');
  buf.push('      media = Array.from(mediaElements).filter(el => parseInt(el.dataset.lang) === currentLanguage).map(el => ({');
  buf.push('        src: el.dataset.src,');
  buf.push('        type: el.dataset.type,');
  buf.push('        question: el.dataset.question,');
  buf.push('        answer: el.dataset.answer');
  buf.push('      }));');
  buf.push('      buildThumbnailsBar();');
  buf.push('    }');

  buf.push('    document.addEventListener("DOMContentLoaded", function() { loadMediaByLanguage(); initLazyLoading(); });');
  buf.push('    function initLazyLoading() {');
  buf.push('      const lazyImages = document.querySelectorAll("img[loading=\'lazy\']");');
  buf.push('      lazyImages.forEach(img => {');
  buf.push('        img.classList.add("loading");');
  buf.push('        img.onload = function() { img.classList.remove("loading"); };');
  buf.push('        img.onerror = function() { img.classList.remove("loading"); };');
  buf.push('      });');
  buf.push('    }');

  buf.push('    function buildThumbnailsBar() {');
  buf.push('      const container = document.getElementById("thumbnails-container");');
  buf.push('      container.innerHTML = "";');
  buf.push('      media.forEach((m, index) => {');
  buf.push('        const thumbnail = document.createElement("img");');
  buf.push('        thumbnail.className = "lightbox-thumbnail";');
  buf.push('        if (m.type === "image") { thumbnail.src = m.src; }');
  buf.push('        else { thumbnail.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22 viewBox=%220 0 60 60%22><rect fill=%22%23e0e0e0%22 width=%2260%22 height=%2260%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2220%22>🎬</text></svg>"; }');
  buf.push('        thumbnail.onclick = function() { showMedia(index); };');
  buf.push('        container.appendChild(thumbnail);');
  buf.push('      });');
  buf.push('    }');

  buf.push('    function updateActiveThumbnail() {');
  buf.push('      document.querySelectorAll(".lightbox-thumbnail").forEach((thumb, index) => {');
  buf.push('        thumb.classList.toggle("active", index === currentIndex);');
  buf.push('      });');
  buf.push('      scrollToActiveThumbnail();');
  buf.push('    }');

  buf.push('    function scrollToActiveThumbnail() {');
  buf.push('      const container = document.getElementById("thumbnails-container");');
  buf.push('      const activeThumbnail = document.querySelector(".lightbox-thumbnail.active");');
  buf.push('      if (!container || !activeThumbnail) return;');
  buf.push('      const containerRect = container.getBoundingClientRect();');
  buf.push('      const thumbnailRect = activeThumbnail.getBoundingClientRect();');
  buf.push('      const scrollLeft = activeThumbnail.offsetLeft - containerRect.width / 2 + thumbnailRect.width / 2;');
  buf.push('      container.scrollTo({ left: scrollLeft, behavior: "smooth" });');
  buf.push('    }');

  buf.push('    function openLightbox(src, type) {');
  buf.push('      const index = media.findIndex(m => m.src === src && m.type === type);');
  buf.push('      if (index === -1) return;');
  buf.push('      currentIndex = index;');
  buf.push('      const imgEl = document.getElementById("lightbox-img");');
  buf.push('      const videoEl = document.getElementById("lightbox-video");');
  buf.push('      const questionEl = document.getElementById("lightbox-question");');
  buf.push('      const answerEl = document.getElementById("lightbox-answer");');
  buf.push('      if (type === "image") {');
  buf.push('        imgEl.style.display = "block"; videoEl.style.display = "none"; videoEl.pause();');
  buf.push('        imgEl.src = src;');
  buf.push('      } else {');
  buf.push('        imgEl.style.display = "none"; videoEl.style.display = "block";');
  buf.push('        videoEl.src = src; videoEl.load();');
  buf.push('      }');
  buf.push('      if (media[currentIndex]) {');
  buf.push('        questionEl.textContent = media[currentIndex].question || "";');
  buf.push('        answerEl.textContent = media[currentIndex].answer || "";');
  buf.push('      }');
  buf.push('      document.getElementById("lightbox").classList.add("active");');
  buf.push('      resetZoom();');
  buf.push('      updateActiveThumbnail();');
  buf.push('    }');

  buf.push('    function closeLightbox() {');
  buf.push('      document.getElementById("lightbox").classList.remove("active");');
  buf.push('      document.getElementById("lightbox-video").pause();');
  buf.push('    }');

  buf.push('    function showMedia(index) {');
  buf.push('      if (index >= 0 && index < media.length) {');
  buf.push('        openLightbox(media[index].src, media[index].type);');
  buf.push('      }');
  buf.push('    }');

  buf.push('    function nextMedia() {');
  buf.push('      if (media.length > 1) { currentIndex = (currentIndex + 1) % media.length; showMedia(currentIndex); }');
  buf.push('    }');

  buf.push('    function prevMedia() {');
  buf.push('      if (media.length > 1) { currentIndex = (currentIndex - 1 + media.length) % media.length; showMedia(currentIndex); }');
  buf.push('    }');

  buf.push('    function zoomIn() { scale = Math.min(scale * 1.2, 5); applyTransform(); }');
  buf.push('    function zoomOut() { scale = Math.max(scale / 1.2, 0.5); applyTransform(); }');
  buf.push('    function resetZoom() { scale = 1; panX = 0; panY = 0; applyTransform(); }');

  buf.push('    function applyTransform() {');
  buf.push('      const imgEl = document.getElementById("lightbox-img");');
  buf.push('      const videoEl = document.getElementById("lightbox-video");');
  buf.push('      imgEl.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + scale + ")";');
  buf.push('      videoEl.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + scale + ")";');
  buf.push('    }');

  buf.push('    const container = document.getElementById("lightbox-container");');
  buf.push('    container.addEventListener("mousedown", function(e) {');
  buf.push('      isDragging = true; startX = e.clientX - panX; startY = e.clientY - panY; container.classList.add("dragging"); e.preventDefault();');
  buf.push('    });');
  buf.push('    document.addEventListener("mousemove", function(e) {');
  buf.push('      if (isDragging) { panX = e.clientX - startX; panY = e.clientY - startY; applyTransform(); }');
  buf.push('    });');
  buf.push('    document.addEventListener("mouseup", function() { isDragging = false; container.classList.remove("dragging"); });');
  buf.push('    container.addEventListener("wheel", function(e) { e.preventDefault(); if (e.deltaY < 0) zoomIn(); else zoomOut(); });');
  buf.push('    document.addEventListener("keydown", function(e) {');
  buf.push('      if (document.getElementById("lightbox").classList.contains("active")) {');
  buf.push('        if (e.key === "ArrowRight") nextMedia();');
  buf.push('        if (e.key === "ArrowLeft") prevMedia();');
  buf.push('        if (e.key === "Escape") closeLightbox();');
  buf.push('        if (e.key === "+" || e.key === "=") zoomIn();');
  buf.push('        if (e.key === "-") zoomOut();');
  buf.push('        if (e.key === "0") resetZoom();');
  buf.push('      }');
  buf.push('    });');
  buf.push('    window.addEventListener("resize", function() {');
  buf.push('      if (document.getElementById("lightbox").classList.contains("active")) { scrollToActiveThumbnail(); }');
  buf.push('    });');

  buf.push('    function openGallery() {');
  buf.push('      const galleryGrid = document.getElementById("gallery-grid");');
  buf.push('      galleryGrid.innerHTML = "";');
  buf.push('      const imageMedia = media.filter(m => m.type === "image");');
  buf.push('      const groupedMedia = {};');
  buf.push('      imageMedia.forEach((m) => {');
  buf.push('        const key = (m.question || "") + "|||" + (m.answer || "");');
  buf.push('        if (!groupedMedia[key]) { groupedMedia[key] = { question: m.question, answer: m.answer, items: [] }; }');
  buf.push('        groupedMedia[key].items.push(m);');
  buf.push('      });');
  buf.push('      let targetElement = null;');
  buf.push('      Object.values(groupedMedia).forEach((group) => {');
  buf.push('        const section = document.createElement("div");');
  buf.push('        section.className = "gallery-section";');
  buf.push('        const header = document.createElement("div");');
  buf.push('        header.className = "gallery-section-header";');
  buf.push('        const questionDiv = document.createElement("div");');
  buf.push('        questionDiv.className = "question";');
  buf.push('        questionDiv.textContent = group.question || "Без вопроса";');
  buf.push('        header.appendChild(questionDiv);');
  buf.push('        const answerDiv = document.createElement("div");');
  buf.push('        answerDiv.className = "answer";');
  buf.push('        answerDiv.textContent = group.answer || "Без ответа";');
  buf.push('        header.appendChild(answerDiv);');
  buf.push('        section.appendChild(header);');
  buf.push('        group.items.forEach((m) => {');
  buf.push('          const galleryItem = document.createElement("div");');
  buf.push('          galleryItem.className = "gallery-item";');
  buf.push('          const img = document.createElement("img");');
  buf.push('          img.src = m.src;');
  buf.push('          img.alt = m.question || "Photo";');
  buf.push('          img.onclick = function() { closeGallery(); openLightbox(m.src, m.type); };');
  buf.push('          galleryItem.appendChild(img);');
  buf.push('          section.appendChild(galleryItem);');
  buf.push('          if (currentIndex >= 0 && currentIndex < media.length && media[currentIndex].src === m.src) { targetElement = galleryItem; }');
  buf.push('        });');
  buf.push('        galleryGrid.appendChild(section);');
  buf.push('      });');
  buf.push('      document.getElementById("gallery-overlay").classList.add("active");');
  buf.push('      closeLightbox();');
  buf.push('      setTimeout(() => { if (targetElement) { targetElement.scrollIntoView({ behavior: "smooth", block: "center" }); } }, 100);');
  buf.push('    }');

  buf.push('    function closeGallery() {');
  buf.push('      document.getElementById("gallery-overlay").classList.remove("active");');
  buf.push('    }');

  buf.push('    document.addEventListener("keydown", function(e) {');
  buf.push('      if (document.getElementById("gallery-overlay").classList.contains("active")) {');
  buf.push('        if (e.key === "Escape") closeGallery();');
  buf.push('      }');
  buf.push('    });');
  buf.push('  </script>');

  buf.push('</body>');
  buf.push('</html>');

  return buf.join('\n');
}

// ------------------------------------------------------------
// Вспомогательная: контент ячейки с медиа
// ------------------------------------------------------------

/**
 * Генерирует HTML для ячейки с медиа-файлами.
 * Порт mediaCellContent() из Dart.
 *
 * ВАЖНО: пути к файлам — подписанные presigned URL из KS3.
 * Если URL нет — fallback на серверный прокси.
 *
 * @param {Function} resolveMediaUrls - (localPath, mediaName) => { full, thumb }
 */
function mediaCellContent(ai, li, qIndex, allMediaByQandAandLang, questionNames, answersByLang, resolveMediaUrls) {
  if (ai >= allMediaByQandAandLang[qIndex][li].length) {
    return '<div class="media-thumbnails"></div>';
  }

  const mediaList = allMediaByQandAandLang[qIndex][li][ai];
  const parts = [];
  const questionName = questionNames[li];
  const escapedAnswerText = ai < answersByLang[li].length
    ? escapeHtml(answersByLang[li][ai].text ?? '')
    : '';

  const maxVisible = 8;
  const visibleCount = Math.min(maxVisible, mediaList.length);

  for (let mi = 0; mi < visibleCount; mi++) {
    const media = mediaList[mi];
    const isImage = media.type.startsWith('image');
    const urls = resolveMediaUrls(media.localPath, media.name);
    const fullSrc = urls.full;
    const thumbnailSrc = urls.thumb || urls.full;
    const escapedName = escapeHtml(media.name ?? '');

    if (isImage) {
      parts.push(
        `<div class="media-item" data-src="${fullSrc}" data-type="image" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'image')">` +
        `<img class="media-thumbnail" src="${thumbnailSrc}" loading="lazy" alt="${escapedName}" />` +
        `</div>`
      );
    } else {
      parts.push(
        `<div class="media-item" data-src="${fullSrc}" data-type="video" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'video')">` +
        `<img class="media-thumbnail" src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 50 50%22><rect fill=%22%23e0e0e0%22 width=%2250%22 height=%2250%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2216%22>🎬</text></svg>" alt="${escapedName}" />` +
        `</div>`
      );
    }
  }

  if (mediaList.length > maxVisible) {
    const hiddenCount = mediaList.length - maxVisible;
    parts.push(
      `<div class="media-item media-item-more" onclick="openGallery()">` +
      `<div class="media-more">+${hiddenCount}</div>` +
      `</div>`
    );
  }

  // Hidden media items (for lightbox navigation)
  for (let mi = visibleCount; mi < mediaList.length; mi++) {
    const media = mediaList[mi];
    const isImage = media.type.startsWith('image');
    const urls = resolveMediaUrls(media.localPath, media.name);
    const fullSrc = urls.full;
    const escapedName = escapeHtml(media.name ?? '');

    if (isImage) {
      parts.push(
        `<div class="media-item media-hidden" data-src="${fullSrc}" data-type="image" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'image')">` +
        `<img class="media-thumbnail" src="${fullSrc}" alt="${escapedName}" />` +
        `</div>`
      );
    } else {
      parts.push(
        `<div class="media-item media-hidden" data-src="${fullSrc}" data-type="video" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'video')">` +
        `<img class="media-thumbnail" src="data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 50 50%22><rect fill=%22%23e0e0e0%22 width=%2250%22 height=%2250%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2216%22>🎬</text></svg>" alt="${escapedName}" />` +
        `</div>`
      );
    }
  }

  return `<div class="media-thumbnails">${parts.join('')}</div>`;
}

module.exports = {
  generateReportHtml,
  escapeHtml,
  escapeHtmlWithBr,
  sortLanguages,
};
