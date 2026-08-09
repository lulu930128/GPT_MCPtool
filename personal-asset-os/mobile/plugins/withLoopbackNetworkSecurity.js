const fs = require('fs');
const path = require('path');
const {
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
} = require('@expo/config-plugins');

const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<network-security-config>
  <base-config cleartextTrafficPermitted="false" />
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="false">127.0.0.1</domain>
    <domain includeSubdomains="false">localhost</domain>
  </domain-config>
</network-security-config>
`;

function withLoopbackNetworkSecurity(config) {
  config = withAndroidManifest(config, (androidConfig) => {
    const application = androidConfig.modResults.manifest.application?.[0];
    if (!application) throw new Error('AndroidManifest.xml is missing an application element');
    application.$['android:networkSecurityConfig'] = '@xml/network_security_config';
    return androidConfig;
  });

  return withDangerousMod(config, [
    'android',
    async (androidConfig) => {
      const targetDirectory = path.join(
        androidConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
        'xml',
      );
      fs.mkdirSync(targetDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(targetDirectory, 'network_security_config.xml'),
        NETWORK_SECURITY_XML,
        'utf8',
      );
      return androidConfig;
    },
  ]);
}

module.exports = createRunOncePlugin(
  withLoopbackNetworkSecurity,
  'with-loopback-network-security',
  '1.0.0',
);
