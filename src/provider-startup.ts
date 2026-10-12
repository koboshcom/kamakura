import {ownerId} from './owner-id.js';
import {config} from './config.js';
import {generationSettings} from './model-provider.js';
import {embeddingConfig} from './embeddings.js';
import {voiceConfig} from './discord-voice-config.js';
import {speechSettings} from './speech.js';
import {providerConfigured,rejectLegacyProviderKey} from './provider-settings.js';
/** Pure validation, runs before transport login or optional capability requests. */
export function validateStartupProviders(){
 rejectLegacyProviderKey();generationSettings('chat');embeddingConfig();
 if(config.replyReview.enabled)generationSettings('review');
 if(config.learning.enabled&&[...config.learning.owners].some(id=>ownerId(id)))generationSettings('learning');
 if(providerConfigured({...config.fastProvider,model:config.fastModel}))generationSettings('fast');
 speechSettings();return voiceConfig();
}
