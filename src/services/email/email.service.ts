import axios from 'axios';
import { EmailJobData } from '../../types';
import { logger } from '../../utils/logger';

const RESEND_API = 'https://api.resend.com/emails';

const sendEmail = async (to: string, subject: string, html: string): Promise<void> => {
  try {
    await axios.post(
      RESEND_API,
      {
        from: process.env.EMAIL_FROM ?? 'noreply@velohr.in',
        to,
        subject,
        html,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      }
    );
    logger.info(`Email sent to ${to}: ${subject}`);
  } catch (error) {
    logger.error('Email send failed', { to, subject, error });
    throw error;
  }
};

// ── Email templates ───────────────────────────────────────────

const selectedTemplate = (candidateName: string, companyName: string): string => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#0f172a;padding:20px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:24px;">🎉 Congratulations!</h1>
  </div>
  <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
    <p style="font-size:16px;color:#334155;">Dear <strong>${candidateName}</strong>,</p>
    <p style="color:#475569;">We are pleased to inform you that you have been <strong>selected</strong> for the next round of the hiring process at <strong>${companyName}</strong>.</p>
    <p style="color:#475569;">Our HR team will reach out to you shortly with further details.</p>
    <p style="color:#64748b;font-size:14px;margin-top:32px;">Best regards,<br/><strong>${companyName} HR Team</strong></p>
  </div>
</div>`;

const rejectedTemplate = (candidateName: string, companyName: string): string => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#0f172a;padding:20px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:24px;">Application Update</h1>
  </div>
  <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
    <p style="font-size:16px;color:#334155;">Dear <strong>${candidateName}</strong>,</p>
    <p style="color:#475569;">Thank you for your interest in joining <strong>${companyName}</strong>.</p>
    <p style="color:#475569;">After careful consideration, we regret to inform you that we are unable to move forward with your application at this time.</p>
    <p style="color:#475569;">We appreciate the time you invested and encourage you to apply for future openings.</p>
    <p style="color:#64748b;font-size:14px;margin-top:32px;">Best regards,<br/><strong>${companyName} HR Team</strong></p>
  </div>
</div>`;

const interviewScheduledTemplate = (
  candidateName: string,
  companyName: string,
  date: string,
  time: string,
  location?: string,
  meetingLink?: string
): string => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#0f172a;padding:20px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:24px;">📅 Interview Scheduled</h1>
  </div>
  <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
    <p style="font-size:16px;color:#334155;">Dear <strong>${candidateName}</strong>,</p>
    <p style="color:#475569;">Your interview with <strong>${companyName}</strong> has been scheduled.</p>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:8px 0;color:#334155;"><strong>📅 Date:</strong> ${date}</p>
      <p style="margin:8px 0;color:#334155;"><strong>⏰ Time:</strong> ${time}</p>
      ${location ? `<p style="margin:8px 0;color:#334155;"><strong>📍 Location:</strong> ${location}</p>` : ''}
      ${meetingLink ? `<p style="margin:8px 0;"><strong>🔗 Meeting Link:</strong> <a href="${meetingLink}" style="color:#3b82f6;">${meetingLink}</a></p>` : ''}
    </div>
    <p style="color:#475569;">Please confirm your availability by replying to this email.</p>
    <p style="color:#64748b;font-size:14px;margin-top:32px;">Best regards,<br/><strong>${companyName} HR Team</strong></p>
  </div>
</div>`;

const welcomeTemplate = (name: string, companyName: string): string => `
<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;padding:24px;">
  <div style="background:#0f172a;padding:20px;border-radius:8px 8px 0 0;">
    <h1 style="color:#fff;margin:0;font-size:24px;">Welcome to VeloHR 🚀</h1>
  </div>
  <div style="background:#f8fafc;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e2e8f0;">
    <p style="font-size:16px;color:#334155;">Hi <strong>${name}</strong>,</p>
    <p style="color:#475569;">Welcome! <strong>${companyName}</strong> is now set up on VeloHR.</p>
    <p style="color:#475569;">You can now upload candidate Excel sheets, configure screening questions, and let our AI voice agents handle your first-round interviews automatically.</p>
    <div style="background:#fff;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;">
      <p style="margin:0 0 8px;color:#334155;font-weight:bold;">Your Trial includes:</p>
      <ul style="color:#475569;margin:0;padding-left:20px;">
        <li>50 candidate screenings</li>
        <li>3 concurrent AI calls</li>
        <li>Resume AI parsing</li>
        <li>Full transcripts & recordings</li>
      </ul>
    </div>
    <p style="color:#64748b;font-size:14px;margin-top:32px;">The VeloHR Team</p>
  </div>
</div>`;

// ── Main dispatcher ───────────────────────────────────────────
export const sendEmailJob = async (job: EmailJobData): Promise<void> => {
  switch (job.type) {
    case 'selected':
      await sendEmail(
        job.to,
        `🎉 You've been selected! - ${job.tenant_name}`,
        selectedTemplate(job.candidate_name, job.tenant_name)
      );
      break;
    case 'rejected':
      await sendEmail(
        job.to,
        `Application Update - ${job.tenant_name}`,
        rejectedTemplate(job.candidate_name, job.tenant_name)
      );
      break;
    case 'interview_scheduled':
      if (!job.interview_details) break;
      await sendEmail(
        job.to,
        `📅 Interview Scheduled - ${job.tenant_name}`,
        interviewScheduledTemplate(
          job.candidate_name,
          job.tenant_name,
          job.interview_details.date,
          job.interview_details.time,
          job.interview_details.location,
          job.interview_details.meeting_link
        )
      );
      break;
    case 'welcome':
      await sendEmail(
        job.to,
        `Welcome to VeloHR - ${job.tenant_name}`,
        welcomeTemplate(job.candidate_name, job.tenant_name)
      );
      break;
    default:
      logger.warn('Unknown email job type', job);
  }
};
