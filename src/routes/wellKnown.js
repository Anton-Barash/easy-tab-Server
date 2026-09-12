'use strict';

// Deep-link сертификаты:
// - /.well-known/assetlinks.json — Android App Links (host verification)
// - /.well-known/apple-app-site-association — iOS Universal Links
// Отдаются на https://easytab.cloud до статики (роуты регистрируются раньше).

// ВАЖНО: подставить реальные SHA256-отпечатки сертификатов подписи APK.
//  - Release APK: SHA256 ключа из key.properties (build.gradle.kts signingConfig release).
//    Получить: keytool -list -v -keystore <storeFile> -alias <keyAlias>
//  - Debug APK (для теста через flutter run): отпечаток debug-keystore,
//    обычно ~/.android/debug.keystore.
// Несоответствие отпечатка -> autoVerify не сработает (ссылка откроется в
// браузере, а не в приложении).
const ANDROID_PACKAGE = 'com.easytab.easy_tab';
const ANDROID_SHA256_FINGERPRINTS = [
  'AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99',
];

// ВАЖНО: подставить реальный Apple Team ID перед bundle id.
// Пример appIDs: 'TEAM1234567.com.easytab.easyTab'
const IOS_TEAM_ID = 'YOUR_TEAM_ID';
const IOS_APP_ID = `${IOS_TEAM_ID}.com.easytab.easyTab`;

async function wellKnownRoutes(fastify) {
  // Android App Links verification file.
  fastify.get('/.well-known/assetlinks.json', async (_request, reply) => {
    reply.header('Content-Type', 'application/json');
    return [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: ANDROID_PACKAGE,
          sha256_cert_fingerprints: ANDROID_SHA256_FINGERPRINTS,
        },
      },
    ];
  });

  // iOS Universal Links verification file (без расширения).
  fastify.get(
    '/.well-known/apple-app-site-association',
    async (_request, reply) => {
      reply.header('Content-Type', 'application/json');
      return {
        applinks: {
          apps: [],
          details: [
            {
              appIDs: [IOS_APP_ID],
              paths: ['*'],
            },
          ],
        },
      };
    },
  );
}

module.exports = wellKnownRoutes;