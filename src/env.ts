import {config as load} from 'dotenv';
import {resolve} from 'node:path';
/** Existing shell values win; normal file wins over optional advanced defaults. */
const path=process.env.DOTENV_CONFIG_PATH??'.env';
load({path:[path,resolve(path,'..','.env.advanced')],override:false,quiet:true});
