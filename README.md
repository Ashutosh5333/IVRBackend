# VeloHR Backend

AI-powered IVR HR Screening Platform — Node.js + TypeScript + Express

## Tech Stack
- **Runtime**: Node.js + TypeScript
- **Framework**: Express.js
- **Database**: Neon DB (PostgreSQL)
- **Cache/Queue**: Upstash Redis + BullMQ
- **Calling**: Twilio (outbound IVR)
- **STT**: Deepgram (Speech-to-Text)
- **TTS**: Google Text-to-Speech
- **Resume AI**: Google Gemini Flash
- **Auth**: JWT + Firebase (Google OAuth)
- **Email**: Resend
- **Realtime**: Socket.io

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure environment
```bash
cp .env.example .env
# Fill in all values in .env
```

### 3. Run migrations
```bash
npm run db:migrate
```

### 4. Seed super admin
```bash
npm run db:seed
# Login: admin@velohr.in / Admin@123
```

### 5. Start development server
```bash
npm run dev
```

### 6. Build for production
```bash
npm run build
npm start
```

## API Routes

| Method | Path | Description |
|--------|------|-------------|
| POST | /api/auth/register | Register new company |
| POST | /api/auth/login | Email/password login |
| POST | /api/auth/google | Firebase Google login |
| POST | /api/auth/refresh | Refresh access token |
| POST | /api/auth/logout | Logout |
| GET  | /api/auth/me | Current user |
| POST | /api/auth/invite | Invite team member |
| GET  | /api/candidates | List candidates |
| POST | /api/candidates/upload-excel | Bulk import from Excel |
| PATCH| /api/candidates/:id/status | Update status |
| POST | /api/calls/initiate | Start single call |
| POST | /api/calls/bulk-start | Start bulk calls |
| GET  | /api/calls | Call session history |
| GET  | /api/questions | Question sets |
| POST | /api/questions | Create question set |
| GET  | /api/interviews | Interviews |
| POST | /api/interviews | Schedule interview |
| GET  | /api/reports/dashboard | Dashboard stats |
| GET  | /api/reports/call-trend | Call trend chart |
| GET  | /api/reports/funnel | Candidate funnel |
| GET  | /api/health | Health check |

## Socket Events

| Event | Direction | Description |
|-------|-----------|-------------|
| call:initiated | Server→Client | Call started |
| call:status | Server→Client | Call status update |
| call:transcript | Server→Client | Live transcript entry |

## Deployment (Render.com)

1. Push to GitHub
2. Create Web Service on Render
3. Build command: `npm run build`
4. Start command: `npm start`
5. Add all environment variables
6. Add UptimeRobot ping to keep alive (free tier)
