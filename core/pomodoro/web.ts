import {BrowserTimerTransport} from './browser.js';
import {mountPomodoro} from './ui.js';
const root=document.getElementById('pomodoro');if(!root)throw Error('POMODORO_ROOT_REQUIRED');
const transport=new BrowserTimerTransport();
mountPomodoro(root,transport,(name,password,register)=>transport.signin(name,password,register));
