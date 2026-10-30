import {mountPomodoro} from '../../core/pomodoro/ui.js';
import {ExtensionTimerTransport} from './transport.js';
const root=document.getElementById('pomodoro');if(!root)throw Error('POMODORO_ROOT_REQUIRED');
mountPomodoro(root,new ExtensionTimerTransport());
