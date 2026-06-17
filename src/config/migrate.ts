import { pool } from './database';
import { logger } from '../utils/logger';
import dotenv from 'dotenv';
dotenv.config();

const migrations = [
  // ── TENANTS (companies using the platform) ────────────────
  `CREATE TABLE IF NOT EXISTS tenants (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    phone VARCHAR(20),
    logo_url TEXT,
    industry VARCHAR(100),
    plan VARCHAR(50) NOT NULL DEFAULT 'trial',
    subscription_status VARCHAR(50) NOT NULL DEFAULT 'active',
    trial_ends_at TIMESTAMPTZ,
    subscription_ends_at TIMESTAMPTZ,
    max_concurrent_calls INTEGER NOT NULL DEFAULT 3,
    max_candidates_per_month INTEGER NOT NULL DEFAULT 50,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── USERS ────────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255),
    first_name VARCHAR(100) NOT NULL,
    last_name VARCHAR(100) NOT NULL,
    phone VARCHAR(20),
    role VARCHAR(50) NOT NULL DEFAULT 'hr_executive',
    is_active BOOLEAN NOT NULL DEFAULT true,
    firebase_uid VARCHAR(128) UNIQUE,
    last_login TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── SUBSCRIPTIONS ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS subscriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    plan VARCHAR(50) NOT NULL,
    status VARCHAR(50) NOT NULL DEFAULT 'active',
    started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    ends_at TIMESTAMPTZ NOT NULL,
    amount_paid DECIMAL(10,2),
    payment_reference VARCHAR(255),
    features JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── QUESTION SETS ─────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS question_sets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    job_role VARCHAR(100) NOT NULL,
    questions JSONB NOT NULL DEFAULT '[]',
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── CAMPAIGNS ────────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS campaigns (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    job_role VARCHAR(100) NOT NULL,
    description TEXT,
    question_set_id UUID REFERENCES question_sets(id),
    total_candidates INTEGER NOT NULL DEFAULT 0,
    called_count INTEGER NOT NULL DEFAULT 0,
    selected_count INTEGER NOT NULL DEFAULT 0,
    rejected_count INTEGER NOT NULL DEFAULT 0,
    status VARCHAR(50) NOT NULL DEFAULT 'draft',
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── CANDIDATES ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS candidates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id) ON DELETE SET NULL,
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255),
    phone VARCHAR(20) NOT NULL,
    job_role VARCHAR(100) NOT NULL,
    resume_url TEXT,
    resume_parsed JSONB,
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    fit_score DECIMAL(4,2),
    call_attempts INTEGER NOT NULL DEFAULT 0,
    last_called_at TIMESTAMPTZ,
    scheduled_call_at TIMESTAMPTZ,
    notes TEXT,
    uploaded_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── CALL SESSIONS ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS call_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    campaign_id UUID REFERENCES campaigns(id),
    twilio_call_sid VARCHAR(64) UNIQUE,
    status VARCHAR(50) NOT NULL DEFAULT 'queued',
    duration_seconds INTEGER,
    recording_url TEXT,
    transcript JSONB DEFAULT '[]',
    answers JSONB DEFAULT '[]',
    score DECIMAL(4,2),
    started_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    initiated_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── PANEL MEMBERS ────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS panel_members (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id),
    name VARCHAR(255) NOT NULL,
    email VARCHAR(255) NOT NULL,
    job_roles JSONB NOT NULL DEFAULT '[]',
    is_available BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── INTERVIEWS ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS interviews (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    candidate_id UUID NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    call_session_id UUID REFERENCES call_sessions(id),
    panel_member_ids JSONB NOT NULL DEFAULT '[]',
    scheduled_at TIMESTAMPTZ NOT NULL,
    duration_minutes INTEGER NOT NULL DEFAULT 45,
    meeting_link TEXT,
    location VARCHAR(255),
    status VARCHAR(50) NOT NULL DEFAULT 'scheduled',
    notes TEXT,
    created_by UUID NOT NULL REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── AUDIT LOGS ───────────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID REFERENCES tenants(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    entity_type VARCHAR(100) NOT NULL,
    entity_id UUID,
    old_value JSONB,
    new_value JSONB,
    ip_address INET,
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── REFRESH TOKENS ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(255) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    revoked BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── SCREEN PERMISSIONS (Admin-managed) ───────────────────
  `CREATE TABLE IF NOT EXISTS screens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(100) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    description TEXT,
    module VARCHAR(100),
    allowed_roles JSONB NOT NULL DEFAULT '[]',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`,

  // ── INDEXES for performance ───────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_candidates_tenant ON candidates(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status)`,
  `CREATE INDEX IF NOT EXISTS idx_candidates_campaign ON candidates(campaign_id)`,
  `CREATE INDEX IF NOT EXISTS idx_call_sessions_tenant ON call_sessions(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_call_sessions_candidate ON call_sessions(candidate_id)`,
  `CREATE INDEX IF NOT EXISTS idx_call_sessions_twilio ON call_sessions(twilio_call_sid)`,
  `CREATE INDEX IF NOT EXISTS idx_users_tenant ON users(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_interviews_tenant ON interviews(tenant_id)`,
  `CREATE INDEX IF NOT EXISTS idx_interviews_scheduled ON interviews(scheduled_at)`,

  // ── Auto-update updated_at trigger ───────────────────────
  `CREATE OR REPLACE FUNCTION update_updated_at_column()
   RETURNS TRIGGER AS $$
   BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
   $$ language 'plpgsql'`,

  `DO $$ BEGIN
    CREATE TRIGGER update_tenants_updated_at BEFORE UPDATE ON tenants
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `DO $$ BEGIN
    CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `DO $$ BEGIN
    CREATE TRIGGER update_candidates_updated_at BEFORE UPDATE ON candidates
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,

  `DO $$ BEGIN
    CREATE TRIGGER update_campaigns_updated_at BEFORE UPDATE ON campaigns
      FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
  EXCEPTION WHEN duplicate_object THEN NULL; END $$`,
];

const runMigrations = async (): Promise<void> => {
  const client = await pool.connect();
  try {
    logger.info('Running database migrations...');
    for (const migration of migrations) {
      await client.query(migration);
    }
    logger.info('✅ All migrations completed successfully');
  } catch (error) {
    logger.error('Migration failed', error);
    throw error;
  } finally {
    client.release();
  }
};

// Run if called directly
if (require.main === module) {
  runMigrations()
    .then(() => process.exit(0))
    .catch(() => process.exit(1));
}

export { runMigrations };
