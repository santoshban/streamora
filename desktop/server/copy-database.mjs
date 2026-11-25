// Copies a Streamora database, even while another server is using it.
// Usage: copy-database.mjs <source> <destination>
import Database from 'better-sqlite3';

const [source, destination] = process.argv.slice(2);
const db = new Database(source, { readonly: true, fileMustExist: true });
try {
  // Fails for a SQLite file that is not a Streamora database.
  db.prepare('SELECT count(*) FROM profiles').get();
  db.prepare('SELECT count(*) FROM libraries').get();
  await db.backup(destination);
} finally {
  db.close();
}
process.exit(0);
