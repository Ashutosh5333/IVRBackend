import { pool } from './database';
import bcrypt from 'bcryptjs';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

const seed = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    logger.info('Seeding database...');

    // Super admin tenant
    await client.query(`
      INSERT INTO tenants (id, name, slug, email, plan, subscription_status, max_concurrent_calls, max_candidates_per_month)
      VALUES ('00000000-0000-0000-0000-000000000001', 'VeloHR Admin', 'velohr-admin', 'admin@velohr.in', 'enterprise', 'active', 999, 999999)
      ON CONFLICT DO NOTHING
    `);

    // Super admin user
    const hash = await bcrypt.hash('Admin@123', 12);
    await client.query(`
      INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
      VALUES ('00000000-0000-0000-0000-000000000001', 'admin@velohr.in', $1, 'Super', 'Admin', 'super_admin')
      ON CONFLICT DO NOTHING
    `, [hash]);

    // Default screens
    const screens = [
      { name: 'Dashboard', slug: 'dashboard', module: 'core', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager','hr_executive','viewer'] },
      { name: 'Candidates', slug: 'candidates', module: 'hr', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager','hr_executive'] },
      { name: 'Calls', slug: 'calls', module: 'hr', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager'] },
      { name: 'Question Sets', slug: 'questions', module: 'hr', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager'] },
      { name: 'Interviews', slug: 'interviews', module: 'hr', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager','hr_executive'] },
      { name: 'Reports', slug: 'reports', module: 'analytics', roles: ['super_admin','tenant_owner','tenant_admin','hr_manager','hr_executive'] },
      { name: 'Team', slug: 'team', module: 'settings', roles: ['super_admin','tenant_owner','tenant_admin'] },
      { name: 'Admin Panel', slug: 'admin', module: 'admin', roles: ['super_admin'] },
    ];

    for (const s of screens) {
      await client.query(`
        INSERT INTO screens (name, slug, module, allowed_roles)
        VALUES ($1, $2, $3, $4) ON CONFLICT (slug) DO NOTHING
      `, [s.name, s.slug, s.module, JSON.stringify(s.roles)]);
    }

    logger.info('✅ Seed completed. Super admin: admin@velohr.in / Admin@123');
  } finally {
    client.release();
    await pool.end();
  }
};

seed().then(() => process.exit(0)).catch((e) => { logger.error(e); process.exit(1); });
