// ─────────────────────────────────────────────────────────────
// VeloHR — Global Types & Interfaces
// ─────────────────────────────────────────────────────────────

// ── Enums ────────────────────────────────────────────────────

export enum UserRole {
  SUPER_ADMIN = 'super_admin',      // Platform owner (you)
  TENANT_OWNER = 'tenant_owner',    // Company that bought subscription
  TENANT_ADMIN = 'tenant_admin',    // Admin within a company
  HR_MANAGER = 'hr_manager',        // HR who uploads & manages calls
  HR_EXECUTIVE = 'hr_executive',    // HR who views reports only
  VIEWER = 'viewer',                // Read-only access
}

export enum SubscriptionPlan {
  TRIAL = 'trial',
  STARTER = 'starter',
  GROWTH = 'growth',
  ENTERPRISE = 'enterprise',
}

export enum SubscriptionStatus {
  ACTIVE = 'active',
  EXPIRED = 'expired',
  CANCELLED = 'cancelled',
  SUSPENDED = 'suspended',
}

export enum CandidateStatus {
  PENDING = 'pending',
  CALLING = 'calling',
  CALL_DONE = 'call_done',
  NO_ANSWER = 'no_answer',
  RESCHEDULED = 'rescheduled',
  SELECTED = 'selected',
  REJECTED = 'rejected',
  INTERVIEW_SCHEDULED = 'interview_scheduled',
}

export enum CallStatus {
  QUEUED = 'queued',
  INITIATED = 'initiated',
  RINGING = 'ringing',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
  FAILED = 'failed',
  NO_ANSWER = 'no_answer',
  BUSY = 'busy',
}

export enum JobRole {
  SOFTWARE_ENGINEER = 'software_engineer',
  AR_CALLER = 'ar_caller',
  PAYMENT_POSTING = 'payment_posting',
  MEDICAL_CODER = 'medical_coder',
  BILLING_SPECIALIST = 'billing_specialist',
  OPERATIONS = 'operations',
  CUSTOMER_SUPPORT = 'customer_support',
  OTHER = 'other',
}

export enum QuestionType {
  OPEN_ENDED = 'open_ended',
  YES_NO = 'yes_no',
  MULTIPLE_CHOICE = 'multiple_choice',
  NUMERIC = 'numeric',
}

export enum InterviewStatus {
  SCHEDULED = 'scheduled',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

// ── Core Entities ─────────────────────────────────────────────

export interface Tenant {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone?: string;
  logo_url?: string;
  industry?: string;
  plan: SubscriptionPlan;
  subscription_status: SubscriptionStatus;
  trial_ends_at?: Date;
  subscription_ends_at?: Date;
  max_concurrent_calls: number;
  max_candidates_per_month: number;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  tenant_id: string;
  email: string;
  password_hash?: string;
  first_name: string;
  last_name: string;
  phone?: string;
  role: UserRole;
  is_active: boolean;
  firebase_uid?: string;
  last_login?: Date;
  created_at: Date;
  updated_at: Date;
}

export interface Candidate {
  id: string;
  tenant_id: string;
  campaign_id?: string;
  name: string;
  email?: string;
  phone: string;
  job_role: JobRole;
  resume_url?: string;
  resume_parsed?: ResumeParsed;
  status: CandidateStatus;
  fit_score?: number;
  call_attempts: number;
  last_called_at?: Date;
  scheduled_call_at?: Date;
  notes?: string;
  uploaded_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface ResumeParsed {
  name: string;
  email?: string;
  phone?: string;
  total_experience_years: number;
  current_role?: string;
  current_company?: string;
  skills: string[];
  education: Array<{ degree: string; institute: string; year?: number }>;
  certifications: string[];
  job_fit: Record<JobRole, number>;
  raw_text?: string;
}

export interface Campaign {
  id: string;
  tenant_id: string;
  name: string;
  job_role: JobRole;
  description?: string;
  question_set_id: string;
  total_candidates: number;
  called_count: number;
  selected_count: number;
  rejected_count: number;
  status: 'draft' | 'active' | 'paused' | 'completed';
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface QuestionSet {
  id: string;
  tenant_id: string;
  name: string;
  job_role: JobRole;
  questions: Question[];
  is_default: boolean;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface Question {
  id: string;
  text: string;
  type: QuestionType;
  options?: string[];
  expected_answer?: string;
  is_mandatory: boolean;
  order: number;
  scoring_keywords?: string[];
}

export interface CallSession {
  id: string;
  tenant_id: string;
  candidate_id: string;
  campaign_id?: string;
  twilio_call_sid?: string;
  status: CallStatus;
  duration_seconds?: number;
  recording_url?: string;
  transcript?: TranscriptEntry[];
  answers?: QuestionAnswer[];
  score?: number;
  started_at?: Date;
  ended_at?: Date;
  initiated_by: string;
  created_at: Date;
}

export interface TranscriptEntry {
  speaker: 'agent' | 'candidate';
  text: string;
  timestamp: number;
}

export interface QuestionAnswer {
  question_id: string;
  question_text: string;
  answer: string;
  score?: number;
}

export interface Interview {
  id: string;
  tenant_id: string;
  candidate_id: string;
  call_session_id?: string;
  panel_member_ids: string[];
  scheduled_at: Date;
  duration_minutes: number;
  meeting_link?: string;
  location?: string;
  status: InterviewStatus;
  notes?: string;
  created_by: string;
  created_at: Date;
  updated_at: Date;
}

export interface PanelMember {
  id: string;
  tenant_id: string;
  user_id: string;
  name: string;
  email: string;
  job_roles: JobRole[];
  is_available: boolean;
  created_at: Date;
}

export interface Subscription {
  id: string;
  tenant_id: string;
  plan: SubscriptionPlan;
  status: SubscriptionStatus;
  started_at: Date;
  ends_at: Date;
  amount_paid?: number;
  payment_reference?: string;
  features: SubscriptionFeatures;
  created_at: Date;
}

export interface SubscriptionFeatures {
  max_concurrent_calls: number;
  max_candidates_per_month: number;
  max_hr_users: number;
  has_resume_parsing: boolean;
  has_analytics: boolean;
  has_api_access: boolean;
  has_custom_questions: boolean;
  data_retention_days: number;
}

export interface AuditLog {
  id: string;
  tenant_id?: string;
  user_id?: string;
  action: string;
  entity_type: string;
  entity_id?: string;
  old_value?: Record<string, unknown>;
  new_value?: Record<string, unknown>;
  ip_address?: string;
  user_agent?: string;
  created_at: Date;
}

// ── Request Types ─────────────────────────────────────────────

export interface AuthenticatedRequest extends Express.Request {
  user?: {
    id: string;
    tenant_id: string;
    role: UserRole;
    email: string;
  };
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  search?: string;
  sort_by?: string;
  sort_order?: 'asc' | 'desc';
}

// ── Response Types ────────────────────────────────────────────

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  meta?: {
    page?: number;
    limit?: number;
    total?: number;
    total_pages?: number;
  };
  errors?: Array<{ field: string; message: string }>;
}

export interface TokenPair {
  access_token: string;
  refresh_token: string;
}

// ── Queue Job Types ───────────────────────────────────────────

export interface CallJobData {
  candidate_id: string;
  campaign_id?: string;
  tenant_id: string;
  question_set_id: string;
  attempt_number: number;
}

export interface TranscriptJobData {
  call_session_id: string;
  recording_url: string;
  tenant_id: string;
}

export interface ResumeJobData {
  candidate_id: string;
  tenant_id: string;
  resume_url: string;
  job_role: JobRole;
}

export interface EmailJobData {
  type: 'selected' | 'rejected' | 'interview_scheduled' | 'call_missed' | 'welcome';
  to: string;
  candidate_name: string;
  tenant_name: string;
  interview_details?: {
    date: string;
    time: string;
    location?: string;
    meeting_link?: string;
  };
}

// ── Socket Event Types ────────────────────────────────────────

export interface CallStatusUpdate {
  call_session_id: string;
  candidate_id: string;
  status: CallStatus;
  duration?: number;
}

export interface LiveTranscriptUpdate {
  call_session_id: string;
  entry: TranscriptEntry;
}
