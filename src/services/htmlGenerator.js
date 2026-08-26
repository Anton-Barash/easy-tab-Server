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
 * @param {string} publicId - публичный ID отчёта (для формирования fallback proxy-путей)
 * @param {string|null} token - JWT-токен (добавляется в URL fallback proxy для приватных отчётов)
 * @param {string} [baseUrl] - базовый URL сервера для абсолютных fallback URL
 * @param {Object} [mediaUrls] - { 'photos/f1.jpg': { full, thumb }, ... } presigned URL из KS3
 * @param {string} [ks3Folder] - папка отчёта в KS3 (не используется напрямую, оставлена для совместимости)
 * @param {string|null} [offlineBasePath] - если задан, медиа ссылки формируются
 *   относительно этого пути. Пустая строка означает корень архива
 *   (например, 'photos/f1.jpg'). Используется для HTML внутри ZIP.
 * @returns {string} HTML-страница
 */
function generateReportHtml(reportData, publicId, token, baseUrl, mediaUrls, ks3Folder, offlineBasePath = null, shareToken = null) {
  if (!reportData) {
    return '<html><body>Нет отчёта</body></html>';
  }

  // Используем серверный прокси для всех медиа, чтобы избежать
  // COEP/CORS-проблем с прямыми presigned URL из KS3 внутри iframe.
  const tokenSuffix = token ? `?token=${encodeURIComponent(token)}` : '';
  const shareSuffix = shareToken ? `${tokenSuffix ? '&' : '?'}share_token=${encodeURIComponent(shareToken)}` : '';
  function resolveMediaUrls(localPath, mediaName) {
    if (offlineBasePath != null) {
      const safePath = (localPath || '').replace(/^\//, '');
      const full = offlineBasePath.length > 0
        ? `${offlineBasePath}/${safePath}`
        : safePath;
      return { full, thumb: full };
    }
    const proxyBase = baseUrl
      ? `${baseUrl}/view/report/${publicId}`
      : `/view/report/${publicId}`;
    const full = `${proxyBase}/files/${localPath}${tokenSuffix}${shareSuffix}`;

    // Проверяем, есть ли реальное превью в mediaUrls (thumb_*.jpg для видео,
    // _thumb.jpg для изображений — загружены клиентом или сгенерированы сервером).
    const mediaEntry = mediaUrls && mediaUrls[localPath];
    const hasRealThumbnail = mediaEntry && mediaEntry.thumb && mediaEntry.thumb !== mediaEntry.full;

    let thumb;
    if (hasRealThumbnail) {
      const isVideo = /\.(mp4|webm|mov|avi)$/i.test(localPath);
      if (isVideo) {
        // Для видео: превью thumb_*.jpg — отдельный файл, загруженный клиентом.
        // Используем прокси /files/ (не /thumbnails/, т.к. sharp не умеет видео).
        const dir = localPath.substring(0, localPath.lastIndexOf('/') + 1);
        const baseName = localPath.substring(localPath.lastIndexOf('/') + 1, localPath.lastIndexOf('.'));
        const thumbPath = `${dir}thumb_${baseName}.jpg`;
        thumb = `${proxyBase}/files/${thumbPath}${tokenSuffix}${shareSuffix}`;
      } else {
        // Для изображений: используем прокси /thumbnails/ (генерирует через sharp).
        thumb = `${proxyBase}/thumbnails/${localPath}${tokenSuffix}${shareSuffix}`;
      }
    } else {
      // Для изображений — прокси /thumbnails/ сгенерирует превью через sharp.
      // Для видео без превью — возвращаем null, чтобы использовать SVG-заглушку,
      // т.к. sharp не умеет обрабатывать видеофайлы.
      const isVideo = /\.(mp4|webm|mov|avi)$/i.test(localPath);
      thumb = isVideo ? null : `${proxyBase}/thumbnails/${localPath}${tokenSuffix}${shareSuffix}`;
    }
    return { full, thumb };
  }

  // P3-54: в HTML включаем только медиа, которые реально загружены на сервер.
  // mediaUrls строится по файлам из БД, поэтому отсутствие URL = файл не загрузился.
  function hasMedia(localPath) {
    return !!(mediaUrls && mediaUrls[localPath] && mediaUrls[localPath].full);
  }

  const reportName = escapeHtml(reportData.reportName ?? '');
  const dateTime = formatDateTime(reportData.timestamp ?? Date.now());
  const allLanguages = reportData.availableLanguages ?? [];
  const languages = sortLanguages(allLanguages);

  // Собираем медиа по вопросам/ответам/языкам (как в _generateHtml).
  // P3-54: пропускаем медиа, которые не загрузились на сервер.
  const allMediaByQandAandLang = [];

  for (let i = 0; i < (reportData.questions ?? []).length; i++) {
    const questionMedia = [];
    for (let li = 0; li < languages.length; li++) {
      const lang = languages[li];
      const answers = getAnswersForQuestion(reportData, i, lang);
      const langMedia = [];
      for (const a of answers) {
        const filteredMedia = a.media.filter((m) => hasMedia(m.localPath));
        langMedia.push(filteredMedia);
      }
      questionMedia.push(langMedia);
    }
    allMediaByQandAandLang.push(questionMedia);
  }

  const buf = [];

  // === HTML HEAD + CSS ===
  buf.push('<!DOCTYPE html>');
  buf.push('<html>');
  buf.push('<head>');
  buf.push('  <meta charset="UTF-8">');
  buf.push('  <meta name="viewport" content="width=device-width, initial-scale=1.0">');
  buf.push(`  <title data-i18n-title="${escapeHtml(reportName)}">${escapeHtml(reportName)} - Отчёт</title>`);
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
  // Top bar: outer — full-width с градиентом-фоном, inner — контент центрирован
  // max-width 680px (оптимальная читаемость), авто-высота по содержимому.
  buf.push('    .lightbox-topbar { position: absolute; top: 0; left: 0; right: 0; z-index: 10002; background: linear-gradient(180deg, rgba(0,0,0,0.55), rgba(0,0,0,0)); padding: 10px 14px 24px 14px; box-sizing: border-box; }');
  buf.push('    .lightbox-topbar-inner { width: 100%; max-width: 680px; margin: 0 auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }');
  buf.push('    .lightbox-topbar .spacer { flex: 1 1 auto; min-width: 8px; }');
  buf.push('    .lightbox-ui-btn { background: rgba(255,255,255,0.2); backdrop-filter: blur(2px); border: none; color: white; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 16px; line-height: 1; transition: background 0.2s; flex: 0 0 auto; display: inline-flex; align-items: center; justify-content: center; height: 38px; min-width: 38px; }');
  buf.push('    .lightbox-ui-btn:hover { background: rgba(255,255,255,0.3); }');
  buf.push('    .lightbox-ui-btn.small { padding: 6px 10px; height: 34px; min-width: 34px; font-size: 14px; }');
  buf.push('    .lightbox-controls { display: flex; gap: 6px; flex-wrap: wrap; }');
  buf.push('    .lightbox-nav { position: absolute; top: 50%; transform: translateY(-50%); background: rgba(255,255,255,0.2); border: none; color: white; padding: 12px 16px; border-radius: 8px; cursor: pointer; font-size: 18px; transition: background 0.2s; z-index: 10001; min-width: 44px; min-height: 44px; display: inline-flex; align-items: center; justify-content: center; }');
  buf.push('    .lightbox-nav:hover { background: rgba(255,255,255,0.3); }');
  buf.push('    .lightbox-nav.prev { left: 16px; }');
  buf.push('    .lightbox-nav.next { right: 16px; }');
  // Кнопки-подсказки (zoom и сетка) исчезают в режиме «без UI» и в gallery-overlay нет.
  // Info-блок: прижат к левому краю (отступ 14px), ширина контента 500px max,
  // высота по контенту (height:auto; min/max-height). Чёрный фон — по ширине контента.
  buf.push('    .lightbox-info { position: absolute; top: 60px; left: 14px; right: auto; transform: none; max-width: 500px; box-sizing: border-box; background: rgba(0,0,0,0.78); color: white; padding: 14px 18px; border-radius: 10px; overflow-y: auto; text-align: left; z-index: 10001; height: auto; min-height: 0; max-height: 36vh; line-height: 1.55; backdrop-filter: blur(3px); box-shadow: 0 6px 24px rgba(0,0,0,0.4); }');
  buf.push('    .attention-answer { color: #f69a15; }');
  buf.push('    .lightbox-question { font-weight: 700; font-size: 15px; margin: 0 0 8px 0; line-height: 1.45; letter-spacing: 0.1px; }');
  buf.push('    .lightbox-answer { font-size: 14.5px; line-height: 1.6; margin: 0; }');
  buf.push('    .lightbox-image-container { position: relative; width: 100%; height: 100%; overflow: hidden; cursor: grab; display: flex; align-items: center; justify-content: center; z-index: 10000; touch-action: none; }');
  buf.push('    .lightbox-image-container.dragging { cursor: grabbing; }');
  buf.push('    .lightbox img { max-width: 100%; max-height: 100%; object-fit: contain; transform-origin: center center; }');
  buf.push('    .lightbox-thumbnails-bar { position: absolute; bottom: 12px; left: 14px; right: 14px; background: rgba(0,0,0,0.7); padding: 8px 10px; border-radius: 8px; overflow: hidden; z-index: 10001; }');
  // Режим «просмотра без UI»: скрыть все, кроме стрелок и самой кнопки-глаз.
  buf.push('    .lightbox.ui-hidden .lightbox-topbar .hide-with-ui, .lightbox.ui-hidden .spacer, .lightbox.ui-hidden .lightbox-controls { display: none !important; }');
  buf.push('    .lightbox.ui-hidden .lightbox-info, .lightbox.ui-hidden .lightbox-thumbnails-bar { display: none !important; }');
  buf.push('    .lightbox.ui-hidden .lightbox-topbar { background: transparent; padding-bottom: 10px; }');
  buf.push('    .lightbox.ui-hidden .lightbox-topbar-inner { justify-content: flex-start; }');
  // Mobile touch-friendly: thumbnails уже адаптивны, делаем info компактнее.
  buf.push('    @media (max-width: 640px) {');
  buf.push('      .lightbox-ui-btn { height: 36px; min-width: 36px; font-size: 15px; padding: 6px 10px; }');
  buf.push('      .lightbox-info { top: 54px; left: 10px; right: 10px; transform: none; max-width: none; padding: 12px 14px; max-height: 32vh; line-height: 1.5; border-radius: 8px; }');
  buf.push('      .lightbox-question { font-size: 14px; }');
  buf.push('      .lightbox-answer { font-size: 13px; }');
  buf.push('      .lightbox-nav { padding: 10px 12px; min-width: 40px; min-height: 40px; font-size: 16px; left: 8px; }');
  buf.push('      .lightbox-nav.next { left: auto; right: 8px; }');
  buf.push('      .lightbox-thumbnails-bar { left: 8px; right: 8px; bottom: 8px; padding: 6px 8px; }');
  buf.push('    }');
  buf.push('    .thumbnails-container { display: flex; gap: 8px; overflow-x: auto; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,0.5) rgba(0,0,0,0.3); }');
  buf.push('    .thumbnails-container::-webkit-scrollbar { height: 6px; }');
  buf.push('    .thumbnails-container::-webkit-scrollbar-track { background: rgba(255,255,255,0.1); border-radius: 3px; }');
  buf.push('    .thumbnails-container::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.5); border-radius: 3px; }');
  buf.push('    .lightbox-thumbnail { width: 60px; height: 60px; object-fit: cover; border-radius: 4px; cursor: pointer; opacity: 0.6; transition: opacity 0.2s, border 0.2s; border: 2px solid transparent; flex: 0 0 auto; }');
  buf.push('    .lightbox-thumbnail:hover { opacity: 1; }');
  buf.push('    .lightbox-thumbnail.active { opacity: 1; border-color: #00B0F0; }');
  buf.push('    @media (max-width: 640px) { .lightbox-thumbnail { width: 48px; height: 48px; } }');
  // Gallery
  buf.push('    .gallery-overlay { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.95); display: none; flex-direction: column; z-index: 9998; }');
  buf.push('    .gallery-overlay.active { display: flex; }');
  buf.push('    .gallery-close { position: absolute; top: 16px; right: 16px; background: rgba(255,255,255,0.15); backdrop-filter: blur(2px); border: none; color: white; width: 40px; height: 40px; border-radius: 50%; font-size: 26px; line-height: 1; cursor: pointer; z-index: 10002; display: inline-flex; align-items: center; justify-content: center; }');
  buf.push('    .gallery-close:hover { background: rgba(255,255,255,0.3); }');
  buf.push('    .gallery-container { flex: 1; overflow-y: auto; padding: 72px 24px 28px; -webkit-overflow-scrolling: touch; }');
  // gallery-grid — НЕ grid (чтобы section-header был отдельно над сеткой).
  // Отдельно каждая секция (.gallery-section-items) уже сама будет grid.
  buf.push('    .gallery-grid { display: block; max-width: 100%; margin: 0 auto; }');
  buf.push('    .gallery-item { position: relative; width: 350px; height: 350px; flex: 0 0 350px; overflow: hidden; border-radius: 0; cursor: pointer; transition: transform 0.2s; background: #222; }');
  buf.push('    .gallery-item:hover { transform: scale(1.02); }');
  buf.push('    .gallery-item img { display: block; width: 100%; height: 100%; object-fit: cover; }');
  buf.push('    .gallery-video-badge { position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.6); color: white; font-size: 11px; padding: 3px 8px; border-radius: 999px; line-height: 1; }');
  // Section: блок с header + отдельным grid с картинками/видео.
  // На десктопе: одна картинка = 350×350 (square), gap = 1px между фото.
  buf.push('    .gallery-section { display: block; margin: 0 0 36px 0; }');
  buf.push('    .gallery-section-header { display: block; width: 100%; color: white; padding: 12px 14px; margin: 0 0 14px 0; font-size: 16px; font-weight: 600; background: rgba(255,255,255,0.04); border-radius: 6px; }');
  buf.push('    .gallery-section-header .question { font-size: 13px; opacity: 0.9; margin-bottom: 4px; }');
  buf.push('    .gallery-section-header .answer { font-size: 16px; font-weight: 700; }');
  buf.push('    .gallery-section-items { display: grid; grid-template-columns: repeat(auto-fill, 350px); gap: 1px; justify-content: start; align-content: start; }');
  // Телефон (<=600px): 3 колонки, gap = 1px между картинками, section-header над сеткой.
  buf.push('    @media (max-width: 600px) {');
  buf.push('      .gallery-container { padding: 56px 6px 24px; }');
  buf.push('      .gallery-close { top: 10px; right: 10px; width: 36px; height: 36px; font-size: 22px; }');
  buf.push('      .gallery-section { margin-bottom: 22px; }');
  buf.push('      .gallery-section-header { padding: 10px 12px; font-size: 14px; margin-bottom: 10px; border-radius: 6px; }');
  buf.push('      .gallery-section-header .question { font-size: 12px; }');
  buf.push('      .gallery-section-header .answer { font-size: 15px; }');
  buf.push('      .gallery-section-items { grid-template-columns: repeat(3, 1fr); gap: 1px; }');
  buf.push('      .gallery-item { width: auto; height: auto; aspect-ratio: 1 / 1; border-radius: 0; flex-basis: auto; }');
  buf.push('      .gallery-video-badge { font-size: 10px; padding: 2px 6px; top: 4px; left: 4px; }');
  buf.push('    }');
  // Header
  buf.push('    .header-row { background: #ffffff !important; color: #6c757d; text-align: left; }');
  buf.push('    .title { font-weight: bold; font-size: 22px; }');
  buf.push('    .border-bold { border-bottom: 2px solid #6c757d !important; font-size: 22px; }');
  buf.push('    .no-border { border-bottom: none !important; font-size: 18px; }');
  // === i18n UI-lang switcher + lightbox UI-strings styles (shared bootstrap) ===
  buf.push(_ui18nInject('css'));
  buf.push('    .ui-lang-wrap { display: flex; justify-content: flex-end; margin: 6px 16px -2px 0; }');
  buf.push('  </style>');
  buf.push('</head>');
  buf.push('<body>');
  // === UI Language switcher (share UI — RU/EN/ZH) — отдельно от переключателя контента.
  buf.push('<div class="ui-lang-wrap"><div id="ui-lang-switcher"></div></div>');

  // === Content language switcher (question/answer languages) ===
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
  // UI-локализованные статические заголовки Excel (Фабрика/Модель/ФОТО) —
  // подменяются JS при загрузке и смене языка интерфейса.
  buf.push('      <td class="border-bold" data-i18n="excel_factory">Фабрика</td>');
  buf.push('      <td class="border-bold" data-i18n="excel_model">Модель</td>');
  buf.push('    </tr>');
  buf.push('    <tr class="header-row">');
  buf.push('      <td class="no-border"></td>');
  buf.push(`      <td class="no-border">${displayDate}</td>`);
  buf.push('      <td class="no-border"></td>');
  buf.push(`      <td class="no-border">${escapeHtml(reportData.factory ?? '')}</td>`);
  buf.push(`      <td class="no-border">${escapeHtml(reportData.model ?? '')}</td>`);
  buf.push('    </tr>');
  buf.push('    <tr class="header-row">');
  buf.push('      <td colspan="5" style="text-align:left; font-weight:bold; padding:8px; color:#6c757d; border-bottom:none;" data-i18n="excel_photoSection">ФОТО</td>');
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
        buf.push(`      <td style="background:#fafafa;font-weight:500;width:48px;color:#00B0F0;">${i + 1}</td>`);
      } else {
        buf.push('      <td style="background:#fafafa;width:48px;"></td>');
      }

      // Question cell
      if (ai === 0) {
        const qParts = [];
        for (let li = 0; li < languages.length; li++) {
          const style = li === 0 ? '' : 'display:none;';
          qParts.push(`<span class="question-lang-${li}" style="${style}">${questionNames[li]}</span>`);
        }
        buf.push(`      <td style="background:#fafafa;font-weight:500;width:220px;">${qParts.join('')}</td>`);
      } else {
        buf.push('      <td style="background:#fafafa;width:220px;"></td>');
      }

      // Attention cell
      if (answerHasAttention[ai]) {
        buf.push('      <td style="text-align:center;vertical-align:middle;width:36px;background:#fff3cd;"><span style="font-weight:bold;color:#ef4444;">!</span></td>');
      } else {
        buf.push('      <td style="text-align:center;vertical-align:middle;width:36px;"></td>');
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
      buf.push(`      <td style="background:${answerBg};width:454px;">${aParts.join('')}</td>`);

      // Media cell
      const mParts = [];
      for (let li = 0; li < languages.length; li++) {
        const style = li === 0 ? '' : 'display:none;';
        mParts.push(`<span class="media-lang-${li}" style="${style}">${mediaCellContent(ai, li, i, allMediaByQandAandLang, questionNames, answersByLang, resolveMediaUrls)}</span>`);
      }
      buf.push(`      <td style="background:#fafafa;width:220px;">${mParts.join('')}</td>`);


      buf.push('    </tr>');
    }
  }

  buf.push('  </table>');
  buf.push('</div>');

  // === Lightbox HTML ===
  buf.push('  <div class="lightbox" id="lightbox">');
  buf.push('    <div class="lightbox-topbar">');
  buf.push('      <div class="lightbox-topbar-inner">');
  // Слева — кнопка-глаз: переключает режим скрытия UI.
  buf.push('        <button class="lightbox-ui-btn" id="lightbox-ui-toggle" onclick="toggleUiVisibility()" data-i18n-title="lb_toggleUi" title="Скрыть/показать элементы управления">');
  buf.push('          <span id="lightbox-eye-icon" style="display:inline-flex;align-items:center;justify-content:center;"></span>');
  buf.push('        </button>');
  buf.push('        <div class="spacer hide-with-ui"></div>');
  // Центр — зум-контролы.
  buf.push('        <div class="lightbox-controls hide-with-ui">');
  buf.push('          <button class="lightbox-ui-btn small" onclick="zoomIn()" data-i18n-title="lb_zoomIn" title="Увеличить">+</button>');
  buf.push('          <button class="lightbox-ui-btn small" onclick="zoomOut()" data-i18n-title="lb_zoomOut" title="Уменьшить">−</button>');
  buf.push('          <button class="lightbox-ui-btn small" onclick="resetZoom()" data-i18n-title="lb_resetZoom" title="Сбросить масштаб">100%</button>');
  buf.push('        </div>');
  buf.push('        <div class="spacer hide-with-ui"></div>');
  // Справа — сетка и закрыть.
  buf.push('        <button class="lightbox-ui-btn hide-with-ui" onclick="openGallery()" data-i18n-title="lb_gallery" title="Просмотр сеткой">⊞</button>');
  buf.push('        <button class="lightbox-ui-btn hide-with-ui" onclick="closeLightbox()" data-i18n-title="lb_close" title="Закрыть">×</button>');
  buf.push('      </div>');
  buf.push('    </div>');
  buf.push('    <div class="lightbox-info">');
  buf.push('      <div class="lightbox-question" id="lightbox-question"></div>');
  buf.push('      <div class="lightbox-answer" id="lightbox-answer"></div>');
  buf.push('    </div>');
  buf.push('    <button class="lightbox-nav prev" onclick="prevMedia()" data-i18n-title="lb_prev" title="Предыдущее">←</button>');
  buf.push('    <div class="lightbox-image-container" id="lightbox-container">');
  buf.push('      <img id="lightbox-img" src="" alt="" style="display:none;" />');
  buf.push('      <video id="lightbox-video" controls autoplay playsinline style="display:none;max-width:100%;max-height:100%;object-fit:contain;"></video>');
  buf.push('    </div>');
  buf.push('    <button class="lightbox-nav next" onclick="nextMedia()" data-i18n-title="lb_next" title="Следующее">→</button>');
  buf.push('    <div class="lightbox-thumbnails-bar" id="lightbox-thumbnails-bar">');
  buf.push('      <div class="thumbnails-container" id="thumbnails-container"></div>');
  buf.push('    </div>');
  buf.push('  </div>');

  // === Gallery overlay ===
  buf.push('  <div class="gallery-overlay" id="gallery-overlay">');
  buf.push('    <button class="gallery-close" onclick="closeGallery()" data-i18n-title="lb_galleryClose" title="Закрыть галерею">×</button>');
  buf.push('    <div class="gallery-container" id="gallery-container">');
  buf.push('      <div class="gallery-grid" id="gallery-grid"></div>');
  buf.push('    </div>');
  buf.push('  </div>');

  // === JavaScript ===
  buf.push('<script>');
  buf.push('    ' + _ui18nInject('script'));
  buf.push('    let currentIndex = 0;');
  buf.push('    let media = [];');
  buf.push('    let scale = 0.9;');
  buf.push('    let panX = 0;');
  buf.push('    let panY = 0;');
  buf.push('    let isDragging = false;');
  buf.push('    let startX = 0;');
  buf.push('    let startY = 0;');
  buf.push('    let startPinchDist = 0;');
  buf.push('    let startPinchScale = 1;');
  buf.push('    let startPinchPanX = 0;');
  buf.push('    let startPinchPanY = 0;');
  buf.push('    let startPinchMidX = 0;');
  buf.push('    let startPinchMidY = 0;');
  buf.push(`    const allLanguages = ${JSON.stringify(languages)};`);
  buf.push('    let currentLanguage = 0;');

  // === UI i18n renderer: применяет переводы к data-i18n / data-i18n-title / title ===
  buf.push('    window.__renderAll = function() {');
  buf.push('      // 1) Все элементы с data-i18n — локализовать innerText.');
  buf.push('      document.querySelectorAll("[data-i18n]").forEach(function(el) { var k = el.getAttribute("data-i18n"); el.innerText = window.__(k); });');
  buf.push('      // 2) Все элементы с data-i18n-title — локализовать title (tooltip).');
  buf.push('      document.querySelectorAll("[data-i18n-title]").forEach(function(el) {');
  buf.push('        var k = el.getAttribute("data-i18n-title"); var t = window.__(k);');
  buf.push('        if (!t || t === k) return; // fallback: оставить исходный title (RU)');
  buf.push('        el.setAttribute("title", t);');
  buf.push('      });');
  buf.push('      // 3) document.title = reportName + " — Отчёт" (с локализацией суффикса).');
  buf.push('      var ttlEl = document.querySelector("title[data-i18n-title]");');
  buf.push('      if (ttlEl) {');
  buf.push('        var rptName = ttlEl.getAttribute("data-i18n-title");');
  buf.push('        document.title = rptName + window.__("excel_suffixTitle");');
  buf.push('      }');
  buf.push('      // 4) Перерисовать UI-переключатель (чтобы active-state совпадал).');
  buf.push('      window.__renderLangSwitcher && window.__renderLangSwitcher("ui-lang-switcher");');
  buf.push('      // 5) Обновить <html lang="">.');
  buf.push('      try { document.documentElement.lang = window.__etLang || "ru"; } catch(e){}');
  buf.push('    };');
  buf.push('    document.addEventListener("DOMContentLoaded", function() {');
  buf.push('      window.__renderLangSwitcher && window.__renderLangSwitcher("ui-lang-switcher");');
  buf.push('      window.__renderAll();');
  buf.push('    });');

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
  buf.push('        thumb: el.dataset.thumb,');
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
  buf.push('        if (m.type === "image") { thumbnail.src = m.thumb || m.src; }');
  buf.push('        else { thumbnail.src = m.thumb && m.thumb !== m.src ? m.thumb : "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2260%22 height=%2260%22 viewBox=%220 0 60 60%22><rect fill=%22%23e0e0e0%22 width=%2260%22 height=%2260%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2220%22>🎬</text></svg>"; }');
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
  buf.push('      document.body.style.overflow = "hidden";');
  buf.push('      resetZoom();');
  buf.push('      updateActiveThumbnail();');
  buf.push('      // Заполняем SVG-иконку кнопки-глаза (иначе span пустой и кнопка невидима).');
  buf.push('      setUiHidden(false);');
  buf.push('    }');

  buf.push('    function closeLightbox() {');
  buf.push('      document.getElementById("lightbox").classList.remove("active");');
  buf.push('      document.body.style.overflow = "";');
  buf.push('      document.getElementById("lightbox-video").pause();');
  buf.push('      setUiHidden(false);');
  buf.push('    }');

  buf.push('    function setUiHidden(hidden) {');
  buf.push('      const lb = document.getElementById("lightbox");');
  buf.push('      const icon = document.getElementById("lightbox-eye-icon");');
  buf.push('      if (!lb || !icon) return;');
  buf.push('      lb.classList.toggle("ui-hidden", !!hidden);');
  buf.push('      icon.innerHTML = hidden');
  buf.push('        ? \'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>\'');
  buf.push('        : \'<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>\';');
  buf.push('    }');

  buf.push('    function toggleUiVisibility() {');
  buf.push('      const lb = document.getElementById("lightbox");');
  buf.push('      setUiHidden(!lb.classList.contains("ui-hidden"));');
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
  buf.push('    function resetZoom() { scale = 0.9; panX = 0; panY = 0; applyTransform(); }');

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
  // Жесты на сенсорных экранах: панорамирование одним пальцем,
  // масштабирование двумя (pinch). preventDefault на touchmove
  // останавливает прокрутку/зум всей страницы.
  buf.push('    container.addEventListener("touchstart", function(e) {');
  buf.push('      if (e.touches.length === 1) {');
  buf.push('        isDragging = true;');
  buf.push('        startX = e.touches[0].clientX - panX;');
  buf.push('        startY = e.touches[0].clientY - panY;');
  buf.push('        container.classList.add("dragging");');
  buf.push('      } else if (e.touches.length === 2) {');
  buf.push('        isDragging = false;');
  buf.push('        container.classList.remove("dragging");');
  buf.push('        const dx = e.touches[0].clientX - e.touches[1].clientX;');
  buf.push('        const dy = e.touches[0].clientY - e.touches[1].clientY;');
  buf.push('        startPinchDist = Math.max(1, Math.sqrt(dx * dx + dy * dy));');
  buf.push('        startPinchScale = scale;');
  buf.push('        startPinchPanX = panX;');
  buf.push('        startPinchPanY = panY;');
  buf.push('        startPinchMidX = (e.touches[0].clientX + e.touches[1].clientX) / 2;');
  buf.push('        startPinchMidY = (e.touches[0].clientY + e.touches[1].clientY) / 2;');
  buf.push('      }');
  buf.push('    }, { passive: false });');
  buf.push('    container.addEventListener("touchmove", function(e) {');
  buf.push('      e.preventDefault();');
  buf.push('      if (e.touches.length === 1 && isDragging) {');
  buf.push('        panX = e.touches[0].clientX - startX;');
  buf.push('        panY = e.touches[0].clientY - startY;');
  buf.push('        applyTransform();');
  buf.push('      } else if (e.touches.length === 2) {');
  buf.push('        const dx = e.touches[0].clientX - e.touches[1].clientX;');
  buf.push('        const dy = e.touches[0].clientY - e.touches[1].clientY;');
  buf.push('        const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));');
  buf.push('        scale = Math.min(Math.max(startPinchScale * (dist / startPinchDist), 0.5), 5);');
  buf.push('        const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;');
  buf.push('        const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;');
  buf.push('        panX = startPinchPanX + (midX - startPinchMidX);');
  buf.push('        panY = startPinchPanY + (midY - startPinchMidY);');
  buf.push('        applyTransform();');
  buf.push('      }');
  buf.push('    }, { passive: false });');
  buf.push('    container.addEventListener("touchend", function() {');
  buf.push('      isDragging = false;');
  buf.push('      container.classList.remove("dragging");');
  buf.push('    });');
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
  buf.push('      const allMedia = media.filter(m => m.type === "image" || m.type === "video");');
  buf.push('      const groupedMedia = {};');
  buf.push('      allMedia.forEach((m) => {');
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
  buf.push('        questionDiv.textContent = group.question || window.__("lb_noQuestion");');
  buf.push('        header.appendChild(questionDiv);');
  buf.push('        const answerDiv = document.createElement("div");');
  buf.push('        answerDiv.className = "answer";');
  buf.push('        answerDiv.textContent = group.answer || window.__("lb_noAnswer");');
  buf.push('        header.appendChild(answerDiv);');
  buf.push('        section.appendChild(header);');
  // Внутренняя grid-обёртка для item'ов (gallery-section-items):
  // section-header остаётся отдельно над сеткой (как подпись к секции).
  buf.push('        const itemsWrap = document.createElement("div");');
  buf.push('        itemsWrap.className = "gallery-section-items";');
  buf.push('        group.items.forEach((m) => {');
  buf.push('          const galleryItem = document.createElement("div");');
  buf.push('          galleryItem.className = "gallery-item";');
  buf.push('          const img = document.createElement("img");');
  // Для видео: показываем реальное превью (thumb). Если thumb отсутствует
  // или совпадает с полным URL (нет отдельной миниатюры) — используем
  // SVG-заглушку с плёнкой (показывает, что это видео, но не перекрывает
  // полезную площадь миниатюры).
  buf.push('          if (m.type === "video") {');
  buf.push('            const hasThumb = m.thumb && m.thumb !== m.src;');
  buf.push('            if (hasThumb) { img.src = m.thumb; }');
  buf.push('            else { img.src = "data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 100 100%22 preserveAspectRatio=%22none%22><defs><linearGradient id=%22g%22 x1=%220%22 y1=%220%22 x2=%221%22 y2=%221%22><stop offset=%220%25%22 stop-color=%22%23475569%22/><stop offset=%22100%25%22 stop-color=%22%230f172a%22/></linearGradient></defs><rect fill=%22url(%23g)%22 width=%22100%22 height=%22100%22/><circle cx=%2250%22 cy=%2250%22 r=%2222%22 fill=%22rgba(0,0,0,0.45)%22/><polygon points=%2243,38 43,62 62,50%22 fill=%22white%22/></svg>";');
  buf.push('            }');
  buf.push('            img.alt = m.question || "Video";');
  buf.push('            const badge = document.createElement("div");');
  buf.push('            badge.className = "gallery-video-badge";');
  buf.push('            badge.textContent = "VIDEO";');
  buf.push('            galleryItem.appendChild(img);');
  buf.push('            galleryItem.appendChild(badge);');
  buf.push('          } else {');
  buf.push('            img.src = m.thumb || m.src;');
  buf.push('            img.alt = m.question || "Photo";');
  buf.push('            galleryItem.appendChild(img);');
  buf.push('          }');
  buf.push('          galleryItem.onclick = function() { closeGallery(); openLightbox(m.src, m.type); };');
  buf.push('          itemsWrap.appendChild(galleryItem);');
  buf.push('          if (currentIndex >= 0 && currentIndex < media.length && media[currentIndex].src === m.src) { targetElement = galleryItem; }');
  buf.push('        });');
  buf.push('        section.appendChild(itemsWrap);');
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
// i18n: локализация UI для share-страниц (welcome + HTML view).
//
// Принцип: в каждую HTML-страницу вшивается маленький JS-блок
// (функции `__ui18nBootstrap` / `__` / `__setLang` / `__renderLangSwitcher`
// + словарь STRINGS на 3 языка). Язык определяется из:
//   1) ?lang= query-параметр (ru|en|zh)
//   2) localStorage 'et.lang'
//   3) navigator.language (браузер)
//   4) fallback 'ru'
// ------------------------------------------------------------

const UI_LANGS = [
  { code: 'ru', label: 'RU' },
  { code: 'en', label: 'EN' },
  { code: 'zh', label: '中文' },
];

// Общий словарь UI-строк (ключ → { ru/en/zh }).
const UI_STRINGS = {
  // ===== SHARE WELCOME =====
  welcome_noName: {
    ru: 'Без названия',
    en: 'Untitled',
    zh: '未命名',
  },
  welcome_editAccess: {
    ru: 'Доступ на редактирование',
    en: 'Editing access',
    zh: '可编辑权限',
  },
  welcome_viewOnlyAccess: {
    ru: 'Доступ только для просмотра',
    en: 'View-only access',
    zh: '仅查看权限',
  },
  welcome_validUntil: {
    ru: 'Ссылка действительна до',
    en: 'Link valid until',
    zh: '链接有效期至',
  },
  welcome_viewOnlyWarning: {
    ru: 'Эта ссылка открыта только для просмотра. Редактирование недоступно.',
    en: 'This link is view-only. Editing is disabled.',
    zh: '此链接仅供查看，无法编辑。',
  },
  welcome_openHtml: {
    ru: 'Просмотр',
    en: 'View',
    zh: '查看',
  },
  welcome_openHtmlDesc: {
    ru: 'Открыть отчёт в лёгкой HTML версии',
    en: 'Open the report in a lightweight HTML view',
    zh: '打开精简 HTML 版报告',
  },
  welcome_edit: {
    ru: 'Редактировать',
    en: 'Edit',
    zh: '编辑',
  },
  welcome_editDesc: {
    ru: 'Редактировать отчёт в браузере',
    en: 'Edit the report in the browser',
    zh: '在浏览器中编辑报告',
  },
  welcome_zip: {
    ru: 'Скачать ZIP',
    en: 'Download ZIP',
    zh: '下载 ZIP',
  },
  welcome_zipDesc: {
    ru: 'Офлайн-копия отчёта',
    en: 'Offline copy of the report',
    zh: '离线副本报告',
  },
  welcome_langLabel: {
    ru: 'Язык',
    en: 'Language',
    zh: '语言',
  },

  // ===== EXCEL HEADER CELLS =====
  excel_suffixTitle: {
    ru: ' - Отчёт',
    en: ' - Report',
    zh: ' - 报告',
  },
  excel_factory: {
    ru: 'Фабрика',
    en: 'Factory',
    zh: '工厂',
  },
  excel_model: {
    ru: 'Модель',
    en: 'Model',
    zh: '型号',
  },
  excel_photoSection: {
    ru: 'ФОТО',
    en: 'PHOTOS',
    zh: '照片',
  },

  // ===== LIGHTBOX =====
  lb_toggleUi: {
    ru: 'Скрыть/показать элементы управления',
    en: 'Hide/show controls',
    zh: '隐藏/显示控件',
  },
  lb_zoomIn: {
    ru: 'Увеличить',
    en: 'Zoom in',
    zh: '放大',
  },
  lb_zoomOut: {
    ru: 'Уменьшить',
    en: 'Zoom out',
    zh: '缩小',
  },
  lb_resetZoom: {
    ru: 'Сбросить масштаб',
    en: 'Reset zoom',
    zh: '重置缩放',
  },
  lb_gallery: {
    ru: 'Просмотр сеткой',
    en: 'Grid view',
    zh: '网格视图',
  },
  lb_close: {
    ru: 'Закрыть',
    en: 'Close',
    zh: '关闭',
  },
  lb_prev: {
    ru: 'Предыдущее',
    en: 'Previous',
    zh: '上一个',
  },
  lb_next: {
    ru: 'Следующее',
    en: 'Next',
    zh: '下一个',
  },
  lb_noQuestion: {
    ru: 'Без вопроса',
    en: 'No question',
    zh: '无问题',
  },
  lb_noAnswer: {
    ru: 'Без ответа',
    en: 'No answer',
    zh: '无答案',
  },
  lb_galleryClose: {
    ru: 'Закрыть галерею',
    en: 'Close gallery',
    zh: '关闭图库',
  },

  // ===== SHARE ERROR =====
  err_titleForbidden: {
    ru: 'Доступ запрещён',
    en: 'Access denied',
    zh: '禁止访问',
  },
  err_msgForbidden: {
    ru: 'У вас нет прав на просмотр этой ссылки, либо она истекла.',
    en: 'You do not have permission to view this link, or it has expired.',
    zh: '您无权查看此链接，或者链接已过期。',
  },
  err_home: {
    ru: 'На главную',
    en: 'Go home',
    zh: '返回首页',
  },
  err_generic: {
    ru: 'Не удалось открыть страницу',
    en: 'Failed to load the page',
    zh: '无法加载页面',
  },
};

/**
 * Сгенерировать JS-код (bootstrap) i18n и вставить его в страницу.
 * Дополнительно подключается CSS для переключателя языка.
 *
 * @param {'script'|'both'} [mode='script'] — только скрипт или скрипт+CSS.
 */
function _ui18nInject(mode = 'script') {
  const lines = [];
  if (mode === 'both' || mode === 'css') {
    lines.push('    .ui-lang-switch { display: flex; align-items: center; gap: 6px; }');
    lines.push('    .ui-lang-switch .lbl { font-size: 12px; color: #666; }');
    lines.push('    .ui-lang-switch .lb { padding: 4px 10px; border: 1px solid #d1d5db; background: white; color: #424242; border-radius: 16px; cursor: pointer; font-size: 12px; line-height: 1; transition: all 0.15s; }');
    lines.push('    .ui-lang-switch .lb.active { background: #00B0F0; color: white; border-color: #00B0F0; }');
    lines.push('    .ui-lang-switch .lb:hover { opacity: 0.85; }');
  }
  if (mode === 'both' || mode === 'script') {
    lines.push(`(function(){`);
    lines.push(`  var L = ${JSON.stringify(UI_LANGS)};`);
    lines.push(`  var S = ${JSON.stringify(UI_STRINGS)};`);
    lines.push(`  var fallback = 'ru';`);
    lines.push(`  var detect = function(){`);
    lines.push(`    try {`);
    lines.push(`      var q = (new URLSearchParams(window.location.search)).get('lang');`);
    lines.push(`      if (q) { var m = L.find(function(x){return x.code===q.toLowerCase()}); if (m) return m.code; }`);
    lines.push(`      var s = window.localStorage.getItem('et.lang');`);
    lines.push(`      if (s) { var m2 = L.find(function(x){return x.code===s.toLowerCase()}); if (m2) return m2.code; }`);
    lines.push(`      var nav = (window.navigator && (window.navigator.language || (window.navigator.languages&&window.navigator.languages[0]) || '')).toLowerCase();`);
    lines.push(`      if (!nav) return fallback;`);
    lines.push(`      if (nav.indexOf('zh')===0) return 'zh';`);
    lines.push(`      if (nav.indexOf('ru')===0) return 'ru';`);
    lines.push(`      if (nav.indexOf('en')===0) return 'en';`);
    lines.push(`      return fallback;`);
    lines.push(`    } catch(e) { return fallback; }`);
    lines.push(`  };`);
    lines.push(`  window.__etLang = detect();`);
    lines.push(`  window.__ = function(k, vars){`);
    lines.push(`    var lang = window.__etLang || fallback; var d = (S[k]||{}); var t = d[lang] != null ? d[lang] : (d[fallback] != null ? d[fallback] : k);`);
    lines.push(`    if (vars && typeof vars === 'object') { Object.keys(vars).forEach(function(v){ t = String(t).replace(new RegExp('\\\\{'+v+'\\\\}','g'), String(vars[v])); }); }`);
    lines.push(`    return t;`);
    lines.push(`  };`);
    lines.push(`  window.__setLang = function(code){`);
    lines.push(`    var m = L.find(function(x){return x.code===code}); if (!m) return;`);
    lines.push(`    window.__etLang = m.code;`);
    lines.push(`    try { window.localStorage.setItem('et.lang', m.code); } catch(e){}`);
    lines.push(`    window.dispatchEvent(new CustomEvent('et-lang-changed', { detail: { code: m.code } }));`);
    lines.push(`    window.__renderAll?.(m.code);`);
    lines.push(`    document.documentElement.lang = m.code;`);
    lines.push(`    document.querySelectorAll('.ui-lang-switch .lb').forEach(function(b){ b.classList.toggle('active', b.dataset.code===m.code); });`);
    lines.push(`  };`);
    lines.push(`  window.__renderLangSwitcher = function(containerId, opts){`);
    lines.push(`    opts = opts || {}; var c = document.getElementById(containerId); if (!c) return;`);
    lines.push(`    c.innerHTML = ''; var wrap = document.createElement('div'); wrap.className = 'ui-lang-switch';`);
    lines.push(`    if (opts.label) { var l = document.createElement('span'); l.className = 'lbl'; l.textContent = opts.labelText || ''; wrap.appendChild(l); }`);
    lines.push(`    L.forEach(function(x){ var b = document.createElement('button'); b.type='button'; b.className='lb' + (window.__etLang===x.code?' active':''); b.dataset.code = x.code; b.textContent = x.label; b.onclick = function(){ window.__setLang(x.code); }; wrap.appendChild(b); });`);
    lines.push(`    c.appendChild(wrap);`);
    lines.push(`  };`);
    lines.push(`})();`);
  }
  return lines.join('\n');
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
        `<div class="media-item" data-src="${fullSrc}" data-thumb="${thumbnailSrc}" data-type="image" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'image')">` +
        `<img class="media-thumbnail" src="${thumbnailSrc}" loading="lazy" alt="${escapedName}" />` +
        `</div>`
      );
    } else {
      // Для видео: если есть реальное превью (thumb_*.jpg), используем его.
      // Иначе — SVG-заглушка с иконкой видеокамеры.
      const hasThumbnail = thumbnailSrc !== fullSrc;
      const videoThumbSrc = hasThumbnail
        ? thumbnailSrc
        : `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 50 50%22><rect fill=%22%23e0e0e0%22 width=%2250%22 height=%2250%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2216%22>🎬</text></svg>`;
      parts.push(
        `<div class="media-item" data-src="${fullSrc}" data-thumb="${videoThumbSrc}" data-type="video" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'video')">` +
        `<img class="media-thumbnail" src="${videoThumbSrc}" loading="lazy" alt="${escapedName}" />` +
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
    const thumbnailSrc = urls.thumb || urls.full;
    const escapedName = escapeHtml(media.name ?? '');

    if (isImage) {
      parts.push(
        `<div class="media-item media-hidden" data-src="${fullSrc}" data-thumb="${thumbnailSrc}" data-type="image" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'image')">` +
        `<img class="media-thumbnail" src="${thumbnailSrc}" alt="${escapedName}" />` +
        `</div>`
      );
    } else {
      const hasThumbnailHidden = thumbnailSrc !== fullSrc;
      const videoThumbSrcHidden = hasThumbnailHidden
        ? thumbnailSrc
        : `data:image/svg+xml,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 50 50%22><rect fill=%22%23e0e0e0%22 width=%2250%22 height=%2250%22/><text x=%2250%25%22 y=%2250%25%22 text-anchor=%22middle%22 dominant-baseline=%22middle%22 font-size=%2216%22>🎬</text></svg>`;
      parts.push(
        `<div class="media-item media-hidden" data-src="${fullSrc}" data-thumb="${videoThumbSrcHidden}" data-type="video" data-question="${questionName}" data-answer="${escapedAnswerText}" data-lang="${li}" onclick="openLightbox('${fullSrc}', 'video')">` +
        `<img class="media-thumbnail" src="${videoThumbSrcHidden}" alt="${escapedName}" />` +
        `</div>`
      );
    }
  }

  return `<div class="media-thumbnails">${parts.join('')}</div>`;
}

// ------------------------------------------------------------
// Welcome-страница share-ссылки (чистый HTML, без Flutter).
// ------------------------------------------------------------

/**
 * Генерирует HTML-welcome страницу для share-ссылки.
 *
 * Отдаётся по GET /reports/shares/:token/welcome. Страница показывает
 * название отчёта, срок действия ссылки и кнопки-действия:
 *   - «Открыть веб-версию» (edit) — Flutter: /#/share-edit?token=...
 *   - «Открыть HTML»              — /reports/shares/:token/html
 *   - «Скачать ZIP»               — /reports/shares/:token/zip
 *
 * Для view-only ссылок кнопка «Открыть веб-версию» не показывается.
 * Все UI-строки (кроме названия отчёта) локализованы inline JS-словарем:
 * RU / EN / ZH, выбор — по query `?lang=`, localStorage, или языку браузера.
 *
 * Безопасность: токен НЕ зашивается в HTML (он уже в URL, которым поделились).
 * Никаких секретов на страницу не попадает.
 *
 * @param {object} share  - объект share-ссылки ({token, permissions, expiresAt})
 * @param {object} report - объект отчёта ({title, reportData})
 * @param {string} baseUrl- базовый URL сервера (protocol://host)
 * @param {object} [labelsIgnored] — (для совместимости, больше не используется)
 */
function generateWelcomeHtml(share, report, baseUrl, labelsIgnored) {
  const reportData = (report && report.reportData) || {};
  // Название отчёта НЕ локализуем — это пользовательские данные.
  // Оно подставляется в JS-рендере с data-i18n-noescape-флагом.
  const title = escapeHtml(reportData.reportName || report.title || '');
  const canEdit = share.permissions === 'edit';

  // Кнопка «Открыть веб-версию» ведёт на /#/share-edit — маршрут, который
  // index.html НЕ перехватывает, поэтому грузится Flutter и сразу открывает
  // редактор отчёта (без welcome-экрана с кнопками).
  const editUrl = `${baseUrl}/#/share-edit?token=${encodeURIComponent(share.token)}`;
  const htmlUrl = `${baseUrl}/reports/shares/${encodeURIComponent(share.token)}/html`;
  const zipUrl = `${baseUrl}/reports/shares/${encodeURIComponent(share.token)}/zip`;

  const expiresAtIso = share.expiresAt ? new Date(share.expiresAt).toISOString() : '';

  const card = (icon, titleKey, subtitleKey, href) => `
    <a href="${href}" class="action-card">
      <div class="action-icon">${icon}</div>
      <div class="action-text">
        <div class="action-title" data-i18n="${titleKey}">${escapeHtml(titleKey)}</div>
        <div class="action-subtitle" data-i18n="${subtitleKey}">${escapeHtml(subtitleKey)}</div>
      </div>
      <div class="action-arrow">›</div>
    </a>`;

  let actionsHtml = '';
  // 1. Просмотр (лёгкая HTML-версия).
  actionsHtml += card('〈/〉', 'welcome_openHtml', 'welcome_openHtmlDesc', htmlUrl);
  if (canEdit) {
    // 2. Редактировать (веб-версия).
    actionsHtml += card('✎', 'welcome_edit', 'welcome_editDesc', editUrl);
  }
  // 3. ZIP всегда доступен. Для view-only zipService автоматически опустит report.json.
  actionsHtml += card('⇩', 'welcome_zip', 'welcome_zipDesc', zipUrl);

  const eyeSvg = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-i18n-doc-title="${escapeHtml(title)}">${escapeHtml(title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #f8f7f2;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    color: #424242;
    display: flex; align-items: center; justify-content: center;
    min-height: 100vh; padding: 24px;
  }
  .container { width: 100%; max-width: 520px; }
  .icon-circle {
    width: 64px; height: 64px; margin: 0 auto 24px;
    background: #e5e7eb; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 30px; color: #333;
  }
  h1 {
    font-size: 24px; font-weight: 700; text-align: center;
    color: #424242; margin-bottom: 8px; word-break: break-word;
  }
  .access-line { font-size: 14px; color: #666; text-align: center; margin-bottom: 4px; }
  .expires-line { font-size: 13px; color: #999; text-align: center; margin-bottom: 32px; }
  .actions { display: flex; flex-direction: column; gap: 12px; }
  .action-card {
    display: flex; align-items: center; gap: 16px;
    background: #ffffff; border: 1px solid #d1d5db; border-radius: 12px;
    padding: 14px 16px; text-decoration: none; color: #424242;
    transition: background 0.15s;
  }
  .action-card:hover { background: #f3f4f6; }
  .action-icon {
    width: 40px; height: 40px; flex-shrink: 0;
    background: #f3f4f6; border-radius: 20px;
    display: flex; align-items: center; justify-content: center;
    font-size: 18px; color: #333;
  }
  .action-text { flex: 1; min-width: 0; }
  .action-title { font-size: 15px; font-weight: 600; color: #424242; }
  .action-subtitle { font-size: 13px; color: #666; margin-top: 2px; }
  .action-arrow { font-size: 22px; color: #999; }
  .view-only-banner {
    background: #fff8e1; border: 1px solid #ffc107; border-radius: 12px;
    padding: 12px 16px; font-size: 13px; color: #424242;
    margin-bottom: 20px; display: flex; gap: 12px; align-items: flex-start;
  }
  .welcome-lang-wrap {
    display: flex; justify-content: flex-end; margin: -12px 0 16px;
  }
${_ui18nInject('css')}
</style>
</head>
<body>
  <div class="container">
    <div class="welcome-lang-wrap"><div id="ui-lang-switcher"></div></div>
    <div class="icon-circle">${canEdit ? '✎' : eyeSvg}</div>
    <h1 id="welcome-report-title">${title}</h1>
    <div class="access-line" data-i18n="${canEdit ? 'welcome_editAccess' : 'welcome_viewOnlyAccess'}">-</div>
    ${expiresAtIso ? `<div class="expires-line" data-expires-iso="${escapeHtml(expiresAtIso)}" data-i18n-prefix="welcome_validUntil">-</div>` : ''}
    ${canEdit ? '' : `<div class="view-only-banner"><span>🔒</span><span data-i18n="welcome_viewOnlyWarning">-</span></div>`}
    <div class="actions">${actionsHtml}</div>
  </div>
<script>
${_ui18nInject('script')}

// === Welcome-page i18n renderer ===
(function () {
  function renderAll() {
    // 1) Обычные data-i18n (тексты).
    document.querySelectorAll('[data-i18n]').forEach(function (el) {
      var k = el.getAttribute('data-i18n'); el.textContent = window.__(k);
    });
    // 2) Expires-строка: "<validUntil>: 12.08.2026 14:30" — локализованное
    //    форматирование даты через Intl.DateTimeFormat, префикс — из словаря.
    var expEl = document.querySelector('[data-i18n-prefix="welcome_validUntil"]');
    if (expEl) {
      var iso = expEl.getAttribute('data-expires-iso');
      var prefix = window.__('welcome_validUntil');
      try {
        var d = new Date(iso);
        var lc = (window.__etLang === 'ru') ? 'ru-RU' : (window.__etLang === 'zh' ? 'zh-CN' : 'en-US');
        var opts = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' };
        expEl.textContent = prefix + ' ' + new Intl.DateTimeFormat(lc, opts).format(d);
      } catch (err) { expEl.textContent = prefix + ' ' + iso; }
    }
    // 3) Заголовок/title документа.
    var reportTitle = (document.getElementById('welcome-report-title') || {}).textContent || '';
    if (reportTitle) { document.title = reportTitle; }
    // 4) Переключатель языка.
    window.__renderLangSwitcher && window.__renderLangSwitcher('ui-lang-switcher');
    try { document.documentElement.lang = window.__etLang || 'ru'; } catch (err) {}
  }
  window.__renderAll = renderAll;
  document.addEventListener('DOMContentLoaded', renderAll);
  window.addEventListener('et-lang-changed', renderAll);
})();
</script>
</body>
</html>`;
}

// ------------------------------------------------------------
// Share-страницы ошибок (403 / общая ошибка) — тоже i18n.
// ------------------------------------------------------------

/**
 * Генерирует HTML для share-ошибки (403 Forbidden / expired / generic).
 * Все строки локализованы (RU/EN/ZH). Детект языка и переключатель включены.
 *
 * @param {403|500} statusCode
 * @param {string} [homeUrl='/'
 */
function generateShareErrorHtml(statusCode, homeUrl = '/') {
  const isForbidden = statusCode === 403;
  const titleKey = isForbidden ? 'err_titleForbidden' : 'err_generic';
  const msgKey = isForbidden ? 'err_msgForbidden' : 'err_generic';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title data-i18n-doc-title="${escapeHtml(titleKey)}">${escapeHtml(titleKey)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background: #f8f7f2; color: #424242;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
    min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 24px;
  }
  .card { width: 100%; max-width: 440px; background: #fff; border: 1px solid #e5e7eb;
    border-radius: 16px; padding: 28px 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.04); }
  .icon { width: 56px; height: 56px; margin: 0 auto 16px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; color: #fff;
    background: ${isForbidden ? '#ef4444' : '#64748b'}; font-size: 24px; }
  h1 { text-align: center; font-size: 20px; font-weight: 700; margin-bottom: 8px; }
  p { text-align: center; color: #6b7280; font-size: 14px; line-height: 1.45; margin-bottom: 20px; }
  a.home-btn { display: inline-flex; align-items: center; justify-content: center;
    width: 100%; padding: 12px 16px; border-radius: 10px; border: none;
    background: #00B0F0; color: white; text-decoration: none; font-size: 14px; font-weight: 600; }
  a.home-btn:hover { opacity: 0.9; }
  .err-lang-wrap { display: flex; justify-content: flex-end; margin: -10px 0 14px; }
${_ui18nInject('css')}
</style>
</head>
<body>
  <div class="card">
    <div class="err-lang-wrap"><div id="ui-lang-switcher"></div></div>
    <div class="icon">${isForbidden ? '🔒' : '⚠️'}</div>
    <h1 data-i18n="${titleKey}">-</h1>
    <p data-i18n="${msgKey}">-</p>
    <a href="${escapeHtml(homeUrl)}" class="home-btn" data-i18n="err_home">-</a>
  </div>
<script>
${_ui18nInject('script')}
(function(){
  function renderAll(){
    document.querySelectorAll('[data-i18n]').forEach(function(el){
      var k = el.getAttribute('data-i18n'); el.textContent = window.__(k);
    });
    var ttl = document.querySelector('title[data-i18n-doc-title]');
    if (ttl) { var k = ttl.getAttribute('data-i18n-doc-title'); document.title = window.__(k); }
    window.__renderLangSwitcher && window.__renderLangSwitcher('ui-lang-switcher');
    try { document.documentElement.lang = window.__etLang || 'ru'; } catch(e){}
  }
  window.__renderAll = renderAll;
  document.addEventListener('DOMContentLoaded', renderAll);
  window.addEventListener('et-lang-changed', renderAll);
})();
</script>
</body>
</html>`;
}

module.exports = {
  generateReportHtml,
  generateWelcomeHtml,
  generateShareErrorHtml,
  escapeHtml,
  escapeHtmlWithBr,
  sortLanguages,
};
