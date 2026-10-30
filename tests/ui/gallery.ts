// DESIGN/COMPONENT PROOF page: invented data only, no account, network or native host.
// The form handler stands in for a surface adapter; primitives never own the effect.
import {button, card, setStatus, statusRegion, textField} from '../../core/ui/dom.js';

const root = document.querySelector('main')!;
const banner = document.createElement('p');
banner.className = 'sp-muted';
banner.textContent = 'Design/component proof · invented data · not an authenticated product or native Mac acceptance';
const title = document.createElement('h1');
title.className = 'sp-title';
title.textContent = 'Shared Spindle primitives';

const form = document.createElement('form');
form.className = 'gallery-form';
const name = textField('Account name', {name: 'name', autocomplete: 'username', required: true, maxLength: 64});
const password = textField('Password', {name: 'password', type: 'password', autocomplete: 'current-password', required: true, minLength: 12, hint: 'At least 12 characters.'});
const signIn = button('Sign in', {variant: 'primary', type: 'submit'});
const actions = document.createElement('div');
actions.className = 'sp-actions';
actions.append(signIn, button('Create account'));
const signInStatus = statusRegion();
form.append(name.root, password.root, actions);
form.addEventListener('submit', event => {
  event.preventDefault();
  signIn.disabled = true;
  setStatus(signInStatus, 'loading', 'Signing in…');
});

const syncActions = document.createElement('div');
syncActions.className = 'sp-actions';
syncActions.append(button('Sync now'), button('Details', {variant: 'quiet'}));

const device = textField('Device name', {name: 'device', value: 'Invented laptop', disabled: true});
const continueActions = document.createElement('div');
continueActions.className = 'sp-actions';
continueActions.append(button('Continue', {variant: 'primary', disabled: true}));

const grid = document.createElement('div');
grid.className = 'gallery-grid';
grid.append(
  card('Sign in', form, signInStatus),
  card('Sync', statusRegion('success', 'Synced 3 invented devices.'), syncActions),
  card('Set up this device',
    statusRegion('loading', 'Checking this device…'),
    statusRegion('error', 'Provider said: <img src=x onerror=alert(1)> access denied.'),
    device.root, continueActions),
);
root.append(banner, title, grid);
document.body.dataset.ready = 'true';
