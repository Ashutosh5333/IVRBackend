import pdfParse from 'pdf-parse';
import mammoth from 'mammoth';
import axios from 'axios';
import { ResumeParsed, JobRole } from '../../types';
import { logger } from '../../utils/logger';

// ── Extract raw text from PDF buffer ─────────────────────────
const extractFromPdf = async (buffer: Buffer): Promise<string> => {
  const data = await pdfParse(buffer);
  return data.text;
};

// ── Extract raw text from DOCX buffer ────────────────────────
const extractFromDocx = async (buffer: Buffer): Promise<string> => {
  const result = await mammoth.extractRawText({ buffer });
  return result.value;
};

// ── Extract text based on file type ──────────────────────────
export const extractResumeText = async (
  buffer: Buffer,
  mimeType: string
): Promise<string> => {
  if (mimeType === 'application/pdf') {
    return extractFromPdf(buffer);
  }
  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword'
  ) {
    return extractFromDocx(buffer);
  }
  throw new Error(`Unsupported resume type: ${mimeType}`);
};

// ── Parse resume text with Gemini AI ─────────────────────────
export const parseResumeWithAI = async (
  rawText: string,
  targetRole: JobRole
): Promise<ResumeParsed> => {
  const prompt = `You are a resume parser. Extract structured data from the resume text below.
Return ONLY a valid JSON object with no markdown, no backticks, no extra text.

Required JSON structure:
{
  "name": "string",
  "email": "string or null",
  "phone": "string or null",
  "total_experience_years": number,
  "current_role": "string or null",
  "current_company": "string or null",
  "skills": ["array", "of", "skills"],
  "education": [{"degree": "string", "institute": "string", "year": number or null}],
  "certifications": ["array"],
  "job_fit": {
    "software_engineer": 0-10,
    "ar_caller": 0-10,
    "payment_posting": 0-10,
    "medical_coder": 0-10,
    "billing_specialist": 0-10,
    "operations": 0-10,
    "customer_support": 0-10,
    "other": 0-10
  }
}

For job_fit scores: 0=no match, 5=partial match, 10=perfect match.
Target role for this candidate: ${targetRole}

Resume text:
${rawText.substring(0, 4000)}`; // Trim to avoid token limits

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 1024,
        },
      },
      { timeout: 15000 }
    );

    const text: string =
      response.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';

    // Strip any accidental markdown fences
    const cleaned = text.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned) as ResumeParsed;
    parsed.raw_text = rawText.substring(0, 2000); // store first 2000 chars

    return parsed;
  } catch (error) {
    logger.error('Gemini resume parsing failed', error);
    // Return minimal parsed data from regex fallback
    return fallbackParse(rawText);
  }
};

// ── Fallback parser (regex-based) if AI fails ────────────────
const fallbackParse = (text: string): ResumeParsed => {
  const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
  const phoneMatch = text.match(/(\+91[\s-]?)?[6-9]\d{9}/);
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  return {
    name: lines[0] ?? 'Unknown',
    email: emailMatch?.[0] ?? undefined,
    phone: phoneMatch?.[0] ?? undefined,
    total_experience_years: 0,
    current_role: undefined,
    current_company: undefined,
    skills: [],
    education: [],
    certifications: [],
    job_fit: {
      [JobRole.SOFTWARE_ENGINEER]: 0,
      [JobRole.AR_CALLER]: 0,
      [JobRole.PAYMENT_POSTING]: 0,
      [JobRole.MEDICAL_CODER]: 0,
      [JobRole.BILLING_SPECIALIST]: 0,
      [JobRole.OPERATIONS]: 0,
      [JobRole.CUSTOMER_SUPPORT]: 0,
      [JobRole.OTHER]: 5,
    },
    raw_text: text.substring(0, 2000),
  };
};
