import Database from 'better-sqlite3';
import { config } from './config.js';

// Lists recent iMessage chats so you can copy IDs into IMESSAGE_ALLOWED_CHATS.
const db = new Database(config.imessageDb, { readonly: true, fileMustExist: true });
const rows = db.prepare(`
  SELECT c.guid, c.display_name AS name, c.chat_identifier AS ident, MAX(m.date) AS last
  FROM chat c JOIN chat_message_join j ON j.chat_id = c.ROWID JOIN message m ON m.ROWID = j.message_id
  GROUP BY c.ROWID ORDER BY last DESC LIMIT 25`).all() as { guid: string; name: string | null; ident: string }[];
for (const row of rows) console.log(`${row.guid}\t${row.name || row.ident}`);
db.close();
