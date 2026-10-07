import {whatsappConfig} from './whatsapp-config.js';
import {WhatsAppTransport} from './transports/whatsapp.js';
import type {Transport} from './types.js';
export function registerWhatsApp(transports:Map<string,Transport>,env:NodeJS.ProcessEnv=process.env,operatorEvent?:ConstructorParameters<typeof WhatsAppTransport>[3]):void {
 const cfg=whatsappConfig(env);
 if(cfg.enabled)transports.set('whatsapp',new WhatsAppTransport(cfg,undefined,undefined,operatorEvent));
}
