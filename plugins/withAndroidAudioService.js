const { withAndroidManifest } = require('expo/config-plugins');

module.exports = (config) => {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application[0];

    if (!app.service) {
      app.service = [];
    }

    const exists = app.service.some(
      (s) => s.$?.['android:name'] === 'expo.modules.audio.service.AudioControlsService'
    );

    if (!exists) {
      app.service.push({
        $: {
          'android:name': 'expo.modules.audio.service.AudioControlsService',
          'android:exported': 'false',
          'android:foregroundServiceType': 'mediaPlayback',
        },
        'intent-filter': [
          {
            action: [
              { $: { 'android:name': 'androidx.media3.session.MediaSessionService' } },
            ],
          },
        ],
      });
    }

    return config;
  });
};
