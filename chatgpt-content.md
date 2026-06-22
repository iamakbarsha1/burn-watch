so im planning to build a dashboard for my company, where I can create a dashboard UI for the management to track the token burn on the called, copilot, and other notable ai in the market, so how can we achieve this? like for example like these GitHub repo, that are used to track the individual token burn in their system, so how can we utilise these data to build a project that can take the data from heir computer on a daily basis and update in out new burn watch tracking project? 1. https://github.com/getagentseal/codeburn 2. https://github.com/ccusage/ccusage (npx ccusage@latest daily --since 20260622 --until 20260622) 3. https://github.com/Ordinath/tokenburn with this context how can achieve to build this project, need better understanding, ask if there's any clarifying questions!

This is a very interesting project, and I think the key insight is:

> Don't try to directly track token usage from AI providers. Instead, build a standardized "usage collector" that gathers token data from tools already installed on developers' machines and sends aggregated metrics to BurnWatch.

## High-Level Architecture

```text
┌─────────────────────┐
│ Developer Laptop    │
├─────────────────────┤
│ Claude Code         │
│ GitHub Copilot      │
│ Cursor             │
│ Windsurf           │
│ OpenAI CLI         │
└──────────┬──────────┘
           │
           ▼

┌─────────────────────┐
│ BurnWatch Agent     │
│ (Local Collector)   │
├─────────────────────┤
│ Parse local logs    │
│ Run ccusage         │
│ Run codeburn        │
│ Run tokenburn       │
│ Normalize data      │
└──────────┬──────────┘
           │ HTTPS
           ▼

┌─────────────────────┐
│ BurnWatch API       │
├─────────────────────┤
│ Store metrics       │
│ Aggregate usage     │
│ Daily snapshots     │
└──────────┬──────────┘
           ▼

┌─────────────────────┐
│ BurnWatch Dashboard │
├─────────────────────┤
│ Daily burn          │
│ Team burn           │
│ Cost estimation     │
│ Trends              │
│ Top users           │
└─────────────────────┘
```

---

# Step 1: Understand the Existing Tools

## CodeBurn

The purpose is:

```text
Claude Code Logs
      ↓
CodeBurn
      ↓
Token Usage
Cost
Session Analytics
```

---

## CCUsage

This is currently the most useful source.

Example:

```bash
npx ccusage@latest daily \
  --since 20260622 \
  --until 20260622
```

Output:

```json
{
  "date": "2026-06-22",
  "inputTokens": 234567,
  "outputTokens": 45678,
  "cacheReadTokens": 12345,
  "cost": 8.43
}
```

You can automate this.

---

## TokenBurn

Another parser around Claude Code logs.

Useful as:

```text
Claude Logs
    ↓
TokenBurn
    ↓
Usage Metrics
```

---

# Step 2: Define a Common Schema

This is the most important part.

Never store raw tool outputs.

Normalize everything.

Example:

```typescript
interface UsageMetric {
  employeeId: string;

  provider: "claude" | "copilot" | "cursor" | "openai" | "windsurf";

  date: string;

  inputTokens: number;

  outputTokens: number;

  cacheTokens: number;

  totalTokens: number;

  estimatedCost: number;

  source: string;

  capturedAt: string;
}
```

Everything gets converted into this structure.

---

# Step 3: Build a Local BurnWatch Agent

Instead of installing CodeBurn manually every day.

Create:

```bash
npm install -g burnwatch-agent
```

or

```bash
brew install burnwatch-agent
```

The agent runs daily.

Example:

```bash
burnwatch sync
```

Internally:

```typescript
collectClaudeUsage();
collectCopilotUsage();
collectCursorUsage();

sendToBurnWatch();
```

---

# Step 4: Daily Sync

Cron Job

Mac:

```bash
0 18 * * * burnwatch sync
```

Windows:

```text
Task Scheduler
```

Daily collection:

```text
6 PM
  ↓
Run ccusage
  ↓
Run tokenburn
  ↓
Normalize
  ↓
POST /usage
```

---

# Step 5: BurnWatch API

Example:

```http
POST /usage
```

Payload:

```json
{
  "employeeId": "akbar",
  "provider": "claude",
  "date": "2026-06-22",
  "inputTokens": 200000,
  "outputTokens": 50000,
  "cost": 6.3
}
```

Store in:

```text
PostgreSQL
```

Tables:

```sql
employees
usage_metrics
daily_snapshots
teams
```

---

# Step 6: Dashboard Metrics

Management usually cares about:

### Daily Burn

```text
Today
Claude      3.2M
Copilot     1.5M
Cursor      0.8M
```

---

### Cost Burn

```text
Today

Claude   $92
Copilot  $30
Cursor   $18
```

---

### Team Comparison

```text
Frontend Team
Backend Team
QA Team
AI Team
```

---

### Top Consumers

```text
1. Akbar
2. John
3. Sarah
```

---

### Burn Trend

```text
Last 30 Days
```

Chart:

```text
Token Burn
↑
|
|
+-------------------->
```

---

# Step 7: Copilot is the Hard Part

Claude Code is easy because:

```text
Local Logs Exist
```

GitHub Copilot is harder.

Questions:

### Which Copilot?

- GitHub Copilot Individual?
- GitHub Copilot Business?
- GitHub Copilot Enterprise?

For Business/Enterprise, there are admin usage APIs available through GitHub.

For Individual users, there is much less visibility.

This is a major design decision.

---

# Step 8: Better Approach

Instead of building separate integrations for every tool:

Create a plugin architecture.

```typescript
interface UsageCollector {
  collect(): Promise<UsageMetric[]>;
}
```

Examples:

```typescript
class ClaudeCollector {}
class CopilotCollector {}
class CursorCollector {}
class OpenAICollector {}
class GeminiCollector {}
```

Then:

```typescript
const collectors = [
  new ClaudeCollector(),
  new CopilotCollector(),
  new CursorCollector(),
];
```

This makes BurnWatch future-proof.

---

# Recommended MVP

I would NOT start with Copilot.

Start with:

### Phase 1

- Claude Code
- CCUsage
- CodeBurn
- TokenBurn

because all of them already expose usable local data.

### Phase 2

- Cursor
- OpenAI
- Gemini CLI

### Phase 3

- GitHub Copilot Business
- Windsurf
- Company-wide analytics

---

A few important questions before designing the exact architecture:

1. Is your company using **Claude Code Max/Team**, or does each developer have their own subscription?
2. Are developers using **GitHub Copilot Business/Enterprise** or personal Copilot accounts?
3. Do you want **per-user tracking** (Akbar used 2M tokens) or only **aggregated company-level tracking**?
4. Can you require developers to install a **BurnWatch Agent** on their machines, or must the solution work without any local installation?
5. What stack are you planning for BurnWatch (MERN, Next.js, PostgreSQL, AWS, etc.)?

The answers to those questions will determine whether BurnWatch should be an **agent-based system** or an **API-only platform**. The agent-based approach is usually the most practical and accurate.

1. some use called max/pro/team plans, each developer have their own subscription
2. itHub Copilot Business/Enterprise with 3000 ai credits each!
3. want per-user tracking (Akbar used 2M tokens)
4. developers to install a BurnWatch Agent on their machines
5. im open, give me the tech stack which is performance friendly, robust, fast, easy to integrate!

Given your answers, **BurnWatch should absolutely be an agent-based system**.

The good news is that this makes the problem much easier because you're not trying to reverse-engineer usage from provider APIs. You're collecting usage locally where the data already exists.

---

# What BurnWatch Actually Becomes

Think of it as:

```text
Datadog
    +
GitHub Insights
    +
AI Cost Analytics
```

but specifically for AI tools.

Management wants answers like:

```text
Today

Claude Code
  12.3M tokens

Copilot
  8.5M tokens

Cursor
  2.1M tokens

Total Cost
  $412

Top Users

1. Akbar
2. John
3. Sarah
```

---

# Recommended Architecture

## BurnWatch Agent

Installed on every machine.

```bash
npm install -g burnwatch-agent
```

or

```bash
brew install burnwatch-agent
```

Responsibilities:

```text
Collect
Normalize
Compress / also we can collect the entire data (like we can have copmress and entire data collection for better analytics!)
Send
```

Nothing else.

---

## BurnWatch Backend

### API

I would use:

```text
Node.js
Fastify
TypeScript
```

Not Express.

Reasons:

- Faster
- Lower memory
- Built-in schema validation
- Better TypeScript support

---

## Database

Use:

```text
PostgreSQL
```

Do NOT use MongoDB.

Reason:

You'll be doing:

```sql
SUM(tokens)
GROUP BY user
GROUP BY provider
GROUP BY date
```

everywhere.

This is PostgreSQL territory.

---

Suggested tables:

```sql
users

organizations

devices

usage_events

daily_usage

monthly_usage
```

---

## Cache Layer

Use:

```text
Redis
```

for:

```text
Dashboard caching
Leaderboard caching
Top users
```

---

## Frontend

Use:

```text
Next.js
App Router
TypeScript
Tailwind
shadcn/ui
Recharts
```

This is probably the fastest path for your team given your React background.

---

# Collection Strategy

This is the most important design decision.

## DO NOT Store Raw Events

Bad:

```json
{
  "prompt": "Create React component"
}
```

Privacy nightmare.

---

Store only:

```json
{
  "provider": "claude",
  "inputTokens": 1200,
  "outputTokens": 900,
  "cost": 0.12
}
```

No prompts.

No completions.

No source code.

Management doesn't need that.

---

# Agent Plugin Architecture

Create:

```typescript
interface UsageCollector {
  name: string;

  collect(since: Date, until: Date): Promise<UsageMetric[]>;
}
```

---

## Claude Collector

Uses:

```text
ccusage
codeburn
tokenburn
```

whichever is available.

```typescript
class ClaudeCollector
```

---

## Copilot Collector

This one is interesting.

Because you're using:

```text
GitHub Copilot Business
```

You can collect from:

- GitHub Copilot Metrics API
- GitHub Enterprise APIs

This provides:

```text
Accepted completions
Usage
Credits consumed
```

The agent can also read local telemetry where available.

---

## Cursor Collector

Read:

```text
Cursor local database
Cursor usage files
```

Many teams are already reverse-engineering this.

---

## Gemini Collector

Read:

```text
Gemini CLI usage
```

---

## OpenAI Collector

Read:

```text
OpenAI API key usage
```

if developers use APIs.

---

# Event Flow

```text
09:00
Agent Starts

↓

Reads Claude Usage

↓

Reads Copilot Usage

↓

Reads Cursor Usage

↓

Normalizes

↓

POST /api/v1/usage

↓

Backend Stores

↓

Dashboard Updates
```

---

# Data Model

Instead of storing daily aggregates only:

Store both.

---

Raw usage:

```sql
usage_events
```

Example:

```json
{
  "userId": "123",
  "provider": "claude",
  "date": "2026-06-22",
  "inputTokens": 50000,
  "outputTokens": 8000
}
```

---

Aggregated:

```sql
daily_usage
```

```json
{
  "userId": "123",
  "date": "2026-06-22",
  "totalTokens": 2200000
}
```

This keeps dashboards fast.

---

# Security Model

Agent registration:

```text
Device ID
Employee ID
Organization ID
```

Agent gets:

```text
JWT
```

Backend validates.

---

Never allow:

```text
Anonymous submissions
```

---

# Cool Features for Management

### BurnWatch Score

```text
Akbar

7-day burn
12.3M

Rank
#2
```

---

### Cost Forecast

```text
Current Month

Expected

$4,200
```

---

### Team Comparison

```text
Backend

34M Tokens

Frontend

28M Tokens
```

---

### AI Tool Adoption

```text
Claude 60%
Copilot 25%
Cursor 10%
Others 5%
```

---

# What I Would Build First (2-Week MVP)

### Agent

- Claude collector only
- Uses ccusage
- Daily sync

### Backend

- Fastify
- PostgreSQL
- Prisma

### Frontend

- Next.js
- Tailwind
- shadcn

### Dashboard

- Daily burn
- User leaderboard
- Cost chart
- Provider chart

That gets you to a working MVP quickly.

---

One thing I'd strongly recommend before writing any code:

Create a **"Source Discovery Matrix"** listing every AI tool your company uses and exactly where usage data comes from.

| Tool                    | Source             | Local Agent | API |
| ----------------------- | ------------------ | ----------- | --- |
| Claude Code             | ccusage / logs     | ✅          | ❌  |
| GitHub Copilot Business | GitHub Metrics API | ⚠️          | ✅  |
| Cursor                  | Local DB/logs      | ✅          | ⚠️  |
| Gemini CLI              | Local logs         | ✅          | ❌  |
| OpenAI API              | Usage API          | ❌          | ✅  |

This matrix will drive the entire BurnWatch architecture and help you estimate implementation effort accurately.
