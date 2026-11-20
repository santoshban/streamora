import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the schema (`npm run db:generate`) and applied
// automatically at server start-up, so no database connection is needed here.
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema.ts',
  out: './drizzle',
});
