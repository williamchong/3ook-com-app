const { withInfoPlist } = require('@expo/config-plugins');

const { APP_BOUND_DOMAINS } = require('../services/app-bound-domains');

module.exports = function withAppBoundDomains(config) {
  return withInfoPlist(config, (modConfig) => {
    modConfig.modResults.WKAppBoundDomains = APP_BOUND_DOMAINS;
    return modConfig;
  });
};
