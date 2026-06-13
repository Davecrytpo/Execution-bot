import pkg from 'pg';
const { Client } = pkg;

const connectionString = 'postgresql://neondb_owner:npg_8zGIU0xNkWMF@ep-lingering-cake-aq84qku3-pooler.c-8.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require';

async function main() {
  const client = new Client({ connectionString });
  try {
    await client.connect();
    console.log('Connected to database.');

    console.log('Updating max_buy_sol to 0.025 for all users...');
    const result = await client.query(`
      UPDATE telegram_users SET
        max_buy_sol = 0.025
    `);
    
    console.log(`Updated ${result.rowCount} users.`);
    console.log('Database update complete.');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.end();
  }
}

main();
