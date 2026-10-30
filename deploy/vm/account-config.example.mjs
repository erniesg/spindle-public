// TEMPLATE for ~/.config/spindle/production/account-config.mjs (never commit the real file).
// Trusted host startup code for build/core/preparation/startup.js. All secrets are read from
// 0600 files under ~/.config/spindle/production/ at startup; none are inlined here or in argv.
// Model/vision declarations, credential callback and limits are owned by the product integrator
// (Pi60) and runtime custodian (65): copy their reviewed values, do not invent prices/models.
import {readFileSync} from 'node:fs';
const dir = '/home/ubuntu/.config/spindle/production';
const json = name => JSON.parse(readFileSync(`${dir}/${name}`, 'utf8'));

export async function preparationAccountConfig() {
  // Account-only baseline: explicit undefined keeps Google/preparation/mail honestly unavailable.
  // After the existing provider operator saves the public callback, replace with json('google-web-client.json')
  // ({clientId, clientSecret}) in the reviewed real config. Do not block account/timer/classification setup on Google.
  const google = undefined;
  const release = json('release.json');          // {revision, tree, buildIdentity} of the exact deployed build
  return {
    // Fixed deployment/privacy fields below win over any copied model fragment.
    // Unpausing requires an explicit reviewed edit here, not a models.mjs override.
    ...(await import(`${dir}/models.mjs`)).productionModels(),
    directory: '/home/ubuntu/.local/share/spindle-production/account', // FRESH production data, not the private 43166 store
    key: readFileSync(`${dir}/account.key`),                             // 32 random bytes, generated once for production
    publicProxy: {token: readFileSync(`${dir}/proxy-token`, 'utf8').trim()}, // internal65 secret, NEVER a provider key/client config
    google,
    port: 43180,                                                         // must equal the VPC service http_port
    publicOrigin: 'https://spindle.berlayar.ai',                          // enables exact Host/Origin checks and Secure cookies
    budgetPath: '/home/ubuntu/.local/share/spindle-production/budget.journal',
    sourceIdentity: {revision: release.revision, tree: release.tree},
    buildIdentity: release.buildIdentity,
    processingPaused: true,                                              // until 60/65 approve model spend for production
    processingPauseReason: 'Production processing not yet enabled',
    // decisionModel, visionModel, credential, limits: REQUIRED from 60/65 reviewed configuration.
  };
}
