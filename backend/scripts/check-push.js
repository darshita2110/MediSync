require('dotenv').config({ quiet: true });
const fs = require('node:fs');
const { GoogleAuth } = require('google-auth-library');
const { pushConfigured } = require('../src/services/fcm');

(async () => {
  if (!pushConfigured()) throw new Error('Set PUSH_ENABLED=true and FIREBASE_PROJECT_ID before checking push credentials');
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (credentialPath) {
    const credential = JSON.parse(fs.readFileSync(credentialPath, 'utf8'));
    if (credential.type === 'service_account' && credential.project_id !== process.env.FIREBASE_PROJECT_ID) {
      throw new Error('Server service-account project does not match FIREBASE_PROJECT_ID');
    }
  }
  const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/firebase.messaging'],
    clientOptions: { transporterOptions: { timeout: 10000, retry: false } } });
  if (!await auth.getAccessToken()) throw new Error('Google did not return an access token');
  console.log('PASS: Firebase server credentials authenticated. No push was sent; device delivery still needs verification.');
})().catch(error => {
  // Provider errors may contain credentials or tokens. Only our fixed setup
  // errors are printed; remote errors are reduced to their class/code.
  const setup = ['Set PUSH_ENABLED=true', 'Server service-account project', 'Google did not return'];
  console.error(setup.some(s => error.message.startsWith(s)) ? error.message : `Push credential check failed (${error.code || error.name}).`);
  process.exitCode = 1;
});
