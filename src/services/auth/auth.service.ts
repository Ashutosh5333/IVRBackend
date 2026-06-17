import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { query, queryOne, withTransaction } from '../../config/database';
import { cacheSet, cacheDel } from '../../config/redis';
import { AppError } from '../../middleware/error.middleware';
import { User, Tenant, UserRole, SubscriptionPlan, TokenPair } from '../../types';
import { logger } from '../../utils/logger';
import admin from 'firebase-admin';
import { PoolClient } from 'pg';

// Init Firebase Admin (once)
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    }),
  });
}

const SALT_ROUNDS = 12;

// ── Generate token pair ───────────────────────────────────────
const generateTokens = (user: User): TokenPair => {
  const payload = {
    userId: user.id,
    tenantId: user.tenant_id,
    role: user.role,
    email: user.email,
  };

  const access_token = jwt.sign(payload, process.env.JWT_ACCESS_SECRET!, {
    expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '15m',
  });

  const refresh_token = jwt.sign(
    { userId: user.id },
    process.env.JWT_REFRESH_SECRET!,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES ?? '7d' }
  );

  return { access_token, refresh_token };
};

// ── Save refresh token hash to DB ─────────────────────────────
// const saveRefreshToken = async (userId: string, token: string): Promise<void> => {
//   const hash = crypto.createHash('sha256').update(token).digest('hex');
//   const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

//   // Revoke old tokens for this user (keep only last 3 devices)
//   await query(
//     `DELETE FROM refresh_tokens WHERE user_id = $1
//      AND id NOT IN (
//        SELECT id FROM refresh_tokens WHERE user_id = $1
//        ORDER BY created_at DESC LIMIT 2
//      )`,
//     [userId]
//   );

//   await query(
//     'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
//     [userId, hash, expiresAt]
//   );
// };
// Change signature to accept an optional client

const saveRefreshToken = async (
  userId: string,
  token: string,
  client?: PoolClient  // ← correct type
): Promise<void> => {
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

  const q = client
    ? (sql: string, params: unknown[]) => client.query(sql, params)
    : (sql: string, params: unknown[]) => query(sql, params);

  await q(
    `DELETE FROM refresh_tokens WHERE user_id = $1
     AND id NOT IN (
       SELECT id FROM refresh_tokens WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 2
     )`,
    [userId]
  );

  await q(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
    [userId, hash, expiresAt]
  );
};

// ── Register new tenant + owner ───────────────────────────────
export const registerTenant = async (data: {
  company_name: string;
  email: string;
  password: string;
  first_name: string;
  last_name: string;
  phone?: string;
  industry?: string;
}): Promise<{ tenant: Tenant; user: User; tokens: TokenPair }> => {
  return withTransaction(async (client) => {
    // Check email exists
    const existing = await client.query(
      'SELECT id FROM users WHERE email = $1',
      [data.email.toLowerCase()]
    );
    if (existing.rows.length > 0) {
      throw new AppError('Email already registered', 409);
    }

    // Create slug from company name
    const slug = data.company_name
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .trim()
      + '-' + uuidv4().substring(0, 6);

    const trialEndsAt = new Date(
      Date.now() + parseInt(process.env.TRIAL_DAYS ?? '14') * 24 * 60 * 60 * 1000
    );

    // Create tenant
    const tenantResult = await client.query(
      `INSERT INTO tenants
        (name, slug, email, phone, industry, plan, subscription_status,
         trial_ends_at, max_concurrent_calls, max_candidates_per_month)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [
        data.company_name,
        slug,
        data.email.toLowerCase(),
        data.phone ?? null,
        data.industry ?? null,
        SubscriptionPlan.TRIAL,
        'active',
        trialEndsAt,
        3,  // trial: 3 concurrent calls
        parseInt(process.env.MAX_TRIAL_CALLS ?? '50'),
      ]
    );
    const tenant = tenantResult.rows[0] as Tenant;

    // Hash password
    const password_hash = await bcrypt.hash(data.password, SALT_ROUNDS);

    // Create owner user
    const userResult = await client.query(
      `INSERT INTO users
        (tenant_id, email, password_hash, first_name, last_name, phone, role)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [
        tenant.id,
        data.email.toLowerCase(),
        password_hash,
        data.first_name,
        data.last_name,
        data.phone ?? null,
        UserRole.TENANT_OWNER,
      ]
    );
    const user = userResult.rows[0] as User;

    const tokens = generateTokens(user);
    await saveRefreshToken(user.id, tokens.refresh_token, client);

    logger.info(`New tenant registered: ${tenant.name} (${tenant.id})`);
    return { tenant, user, tokens };
  });
};

// ── Login with email/password ─────────────────────────────────
export const loginWithPassword = async (
  email: string,
  password: string
): Promise<{ user: User; tenant: Tenant; tokens: TokenPair }> => {
  const user = await queryOne<User>(
    'SELECT * FROM users WHERE email = $1 AND is_active = true',
    [email.toLowerCase()]
  );

  if (!user || !user.password_hash) {
    throw new AppError('Invalid credentials', 401);
  }

  const isValid = await bcrypt.compare(password, user.password_hash);
  if (!isValid) {
    throw new AppError('Invalid credentials', 401);
  }

  const tenant = await queryOne<Tenant>(
    'SELECT * FROM tenants WHERE id = $1 AND is_active = true',
    [user.tenant_id]
  );
  if (!tenant) {
    throw new AppError('Account suspended. Contact support.', 403);
  }

  // Update last login
  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const tokens = generateTokens(user);
  await saveRefreshToken(user.id, tokens.refresh_token);

  return { user, tenant, tokens };
};

// ── Firebase Google auth ──────────────────────────────────────
export const loginWithFirebase = async (
  idToken: string
): Promise<{ user: User; tenant: Tenant; tokens: TokenPair; isNew: boolean }> => {
  // Verify Firebase token
  const decoded = await admin.auth().verifyIdToken(idToken);
  const { uid, email, name } = decoded;

  if (!email) throw new AppError('Email not available from Google account', 400);

  // Find existing user
  let user = await queryOne<User>(
    'SELECT * FROM users WHERE firebase_uid = $1 OR email = $2',
    [uid, email.toLowerCase()]
  );

  let isNew = false;

  // if (!user) {
  //   // New user via Google — create pending (needs tenant setup)
  //   throw new AppError('Account not found. Please register first.', 404);
  // }
  if (!user) {
    // First-time Google sign-in — auto-provision tenant + user
    const nameParts = (name ?? '').split(' ');
    const firstName = nameParts[0] ?? 'User';
    const lastName = nameParts.slice(1).join(' ') || '-';
  
    const result = await withTransaction(async (client) => {
      const slug =
        email.toLowerCase().replace(/[^a-z0-9]/g, '-') +
        '-' + uuidv4().substring(0, 6);
  
      const trialEndsAt = new Date(
        Date.now() + parseInt(process.env.TRIAL_DAYS ?? '14') * 24 * 60 * 60 * 1000
      );
  
      const tenantResult = await client.query(
        `INSERT INTO tenants
          (name, slug, email, plan, subscription_status,
           trial_ends_at, max_concurrent_calls, max_candidates_per_month)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          email, slug, email.toLowerCase(),
          SubscriptionPlan.TRIAL, 'active', trialEndsAt,
          3, parseInt(process.env.MAX_TRIAL_CALLS ?? '50'),
        ]
      );
      const newTenant = tenantResult.rows[0] as Tenant;
  
      const userResult = await client.query(
        `INSERT INTO users
          (tenant_id, email, firebase_uid, first_name, last_name, role)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING *`,
        [newTenant.id, email.toLowerCase(), uid, firstName, lastName, UserRole.TENANT_OWNER]
      );
      const newUser = userResult.rows[0] as User;
  
      const tokens = generateTokens(newUser);
      await saveRefreshToken(newUser.id, tokens.refresh_token, client);
  
      return { user: newUser, tenant: newTenant, tokens, isNew: true };
    });
  
    return result;
  }

  // Link Firebase UID if not linked yet
  if (!user.firebase_uid) {
    await query('UPDATE users SET firebase_uid = $1 WHERE id = $2', [uid, user.id]);
  }

  const tenant = await queryOne<Tenant>(
    'SELECT * FROM tenants WHERE id = $1 AND is_active = true',
    [user.tenant_id]
  );
  if (!tenant) throw new AppError('Tenant not found', 404);

  await query('UPDATE users SET last_login = NOW() WHERE id = $1', [user.id]);

  const tokens = generateTokens(user);
  await saveRefreshToken(user.id, tokens.refresh_token);

  return { user, tenant, tokens, isNew };
};


// ── Refresh token ─────────────────────────────────────────────
export const refreshAccessToken = async (
  refreshToken: string
): Promise<{ access_token: string }> => {
  let payload: { userId: string };

  try {
    payload = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET!) as {
      userId: string;
    };
  } catch {
    throw new AppError('Invalid or expired refresh token', 401);
  }

  const hash = crypto.createHash('sha256').update(refreshToken).digest('hex');
  const stored = await queryOne(
    `SELECT * FROM refresh_tokens
     WHERE user_id = $1 AND token_hash = $2
     AND revoked = false AND expires_at > NOW()`,
    [payload.userId, hash]
  );

  if (!stored) throw new AppError('Refresh token not found or expired', 401);

  const user = await queryOne<User>(
    'SELECT * FROM users WHERE id = $1 AND is_active = true',
    [payload.userId]
  );
  if (!user) throw new AppError('User not found', 401);

  const access_token = jwt.sign(
    { userId: user.id, tenantId: user.tenant_id, role: user.role, email: user.email },
    process.env.JWT_ACCESS_SECRET!,
    { expiresIn: process.env.JWT_ACCESS_EXPIRES ?? '15m' }
  );

  return { access_token };
};


// ── Logout - blacklist token ──────────────────────────────────
export const logout = async (
  userId: string,
  accessToken: string
): Promise<void> => {
  // Blacklist current access token (until natural expiry)
  await cacheSet(`blacklist:${accessToken}`, true, 15 * 60);

  // Revoke all refresh tokens for user
  await query(
    'UPDATE refresh_tokens SET revoked = true WHERE user_id = $1',
    [userId]
  );
};

// ── Invite user to tenant ─────────────────────────────────────
export const inviteUser = async (data: {
  tenant_id: string;
  email: string;
  first_name: string;
  last_name: string;
  role: UserRole;
  invited_by: string;
}): Promise<User> => {
  const existing = await queryOne<User>(
    'SELECT id FROM users WHERE email = $1',
    [data.email.toLowerCase()]
  );
  if (existing) throw new AppError('User already exists', 409);

  // Generate temp password
  const tempPassword = crypto.randomBytes(8).toString('hex');
  const password_hash = await bcrypt.hash(tempPassword, SALT_ROUNDS);

  const result = await query<User>(
    `INSERT INTO users (tenant_id, email, password_hash, first_name, last_name, role)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [data.tenant_id, data.email.toLowerCase(), password_hash, data.first_name, data.last_name, data.role]
  );

  // TODO: Send invite email with tempPassword
  logger.info(`User invited: ${data.email} to tenant ${data.tenant_id}`);

  return result[0];
};
