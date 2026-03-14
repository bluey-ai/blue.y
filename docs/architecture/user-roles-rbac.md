# BLUE.Y — User Roles & RBAC Architecture

> **Design spec for the Admin / Operator / User permission model.**
> Jira: HUBS-6145

---

## Overview

BLUE.Y has two completely different personalities depending on who is talking to it:

- **Admin / Operator** → a powerful ops tool that speaks Kubernetes
- **Regular User** → a friendly helpdesk that speaks plain English

The same underlying system, two entirely different experiences.

---

## The Three Roles

### Admin — DevOps / Infra Engineer
Full access. All commands. All alerts.

```
What they can do:
  ✅ All monitoring commands (/status, /nodes, /hpa, /load, /doris)
  ✅ All pod commands (/logs, /describe, /events, /diagnose)
  ✅ All action commands (/restart, /scale, /rollout)
  ✅ WAF management (/waf, /waf block <ip>)
  ✅ Security scanner (/scan <repo>)
  ✅ Email escalation (/email)
  ✅ Jira ticket creation (/jira)
  ✅ Sleep/wake monitoring (/sleep, /wake)
  ✅ Confirm/deny actions (/yes, /no)
  ✅ Configure BLUE.Y settings

What they receive:
  📢 All alerts — critical, high, medium
  📢 AI diagnose reports on every critical event
  📢 Pre-scale notifications
  📢 WAF spike and auto-block notifications
  📢 Security scan results

Response style:
  Technical — pod names, namespaces, CPU millicores, MB values
```

---

### Operator — On-call / SRE / Senior Developer
Action access, but no infrastructure or security mutations.

```
What they can do:
  ✅ All monitoring commands
  ✅ All pod commands (/logs, /describe, /events, /diagnose)
  ✅ Restart pods (/restart)
  ✅ Scale deployments (/scale) — NOT node groups
  ✅ View WAF dashboard (/waf) — NOT block/unblock
  ✅ Create Jira tickets (/jira)
  ✅ Confirm/deny actions (/yes, /no)
  ❌ WAF mutations (block/unblock IP)
  ❌ Security scanner
  ❌ Node group scaling
  ❌ Email escalation
  ❌ Sleep/wake (would silence alerts for whole team)

What they receive:
  📢 Critical and high alerts only
  📢 AI diagnose reports on critical events
  📢 Pre-scale notifications

Response style:
  Technical — same as admin
```

---

### User — Developer / PM / HR / Finance / Anyone non-ops
Self-service only. No cluster visibility. No unsolicited messages.

```
What they can do:
  ✅ /status      — plain English health check
  ✅ /ping <name> — "is login up?"
  ✅ /incidents   — simplified outage summary
  ✅ /reset password — reset their own AWS IAM console password
  ✅ /help        — shows only their available commands
  ❌ Everything else

What they receive:
  📢 NOTHING automatically — no alerts, no noise
  📢 Only when a user-facing service goes down:
     "⚠️ The login service is currently down.
      Our team has been notified. We'll update you shortly."

Response style:
  Plain English — NO pod names, NO namespaces, NO K8s terms
  "The login service is down" NOT "pod user-mgmt-be-7d9f4 in CrashLoopBackOff"
```

---

## Command Matrix

```
Command              │ Admin │ Operator │ User │ Notes
─────────────────────┼───────┼──────────┼──────┼──────────────────────────────
/status              │  ✅   │    ✅    │  ✅  │ User gets plain English only
/help                │  ✅   │    ✅    │  ✅  │ Shows only their role's cmds
/ping <service>      │  ✅   │    ✅    │  ✅  │ User gets "up" or "down" only
/incidents           │  ✅   │    ✅    │  ✅  │ User gets simplified summary
/reset password      │  ❌   │    ❌    │  ✅  │ AWS IAM self-service
─────────────────────┼───────┼──────────┼──────┼──────────────────────────────
/logs <pod>          │  ✅   │    ✅    │  ❌  │
/events [ns]         │  ✅   │    ✅    │  ❌  │
/describe <pod>      │  ✅   │    ✅    │  ❌  │
/diagnose <pod>      │  ✅   │    ✅    │  ❌  │ AI full analysis
/nodes               │  ✅   │    ✅    │  ❌  │
/hpa [ns]            │  ✅   │    ✅    │  ❌  │
/deployments [ns]    │  ✅   │    ✅    │  ❌  │
/load                │  ✅   │    ✅    │  ❌  │
/doris               │  ✅   │    ✅    │  ❌  │
/resources [ns]      │  ✅   │    ✅    │  ❌  │
/check               │  ✅   │    ✅    │  ❌  │
─────────────────────┼───────┼──────────┼──────┼──────────────────────────────
/restart <deploy>    │  ✅   │    ✅    │  ❌  │ Requires /yes confirm
/rollout <deploy>    │  ✅   │    ✅    │  ❌  │ Requires /yes confirm
/scale <deploy> <N>  │  ✅   │    ✅    │  ❌  │ Requires /yes confirm
/jira                │  ✅   │    ✅    │  ❌  │
/yes  /no            │  ✅   │    ✅    │  ❌  │
─────────────────────┼───────┼──────────┼──────┼──────────────────────────────
/waf                 │  ✅   │    👁️    │  ❌  │ Operator: view only
/waf block <ip>      │  ✅   │    ❌    │  ❌  │
/scan <repo>         │  ✅   │    ❌    │  ❌  │
/email <to>          │  ✅   │    ❌    │  ❌  │
/sleep   /wake       │  ✅   │    ❌    │  ❌  │
─────────────────────┼───────┼──────────┼──────┼──────────────────────────────
Unknown caller       │  ❌   │    ❌    │  ❌  │ "Not registered. Contact IT."
```

---

## Alert Routing Matrix

```
Alert Type      │ Admin │ Operator │ User │ Channel
────────────────┼───────┼──────────┼──────┼─────────────────────────────────
critical        │  ✅   │    ✅    │  ❌  │ DM all admins + operators
                │       │          │      │ + Slack #ops-alerts
                │       │          │      │ + Teams ops channel
high            │  ✅   │    ✅    │  ❌  │ Slack #ops-alerts only
                │       │          │      │ (no DMs unless configured)
warning         │  ✅   │    ❌    │  ❌  │ Admin DMs only
info            │  ❌   │    ❌    │  ❌  │ Logged only — no notification
────────────────┼───────┼──────────┼──────┼─────────────────────────────────
user-facing     │  ✅   │    ✅    │  ✅  │ Admin+Operator: technical alert
service down    │       │          │      │ Users: plain English DM
                │       │          │      │ "The login service is down."
user-facing     │  ❌   │    ❌    │  ✅  │ Users: plain English recovery DM
service up      │       │          │      │ "Login service is back ✅"
```

**"User-facing service"** is defined in `values.yaml`:
```yaml
services:
  - name: "login"
    deployment: user-management-be-production
    userFacing: true          # triggers user notifications on down/up
    friendlyName: "Login"     # used in plain English messages
  - name: "platform"
    deployment: jcp-blo-backend-hubs20-production
    userFacing: true
    friendlyName: "Main platform"
  - name: "reports"
    deployment: pdf-service-pdf-production
    userFacing: true
    friendlyName: "Reports"
```

---

## Identity — How BLUE.Y Knows Who You Are

Each platform uses a different identifier. The `CallerIdentity` object normalizes all of them:

```typescript
interface CallerIdentity {
  platform: 'telegram' | 'slack' | 'teams' | 'whatsapp';
  id: string;          // platform-native unique ID
  displayName: string; // best-effort name from platform
  rawMessage: string;  // original message text
}
```

Platform-specific identity sources:

```
Platform    │ Identity field              │ Example value
────────────┼─────────────────────────────┼──────────────────────
Telegram    │ ctx.from.id (number)        │ 123456789
Slack       │ event.user (string)         │ U01ABC123
MS Teams    │ activity.from.aadObjectId   │ "550e8400-e29b-41d4-a716-..."
WhatsApp    │ From header (E.164 phone)   │ +6512345678
```

**Important:** The `id` field in `values.yaml` must match exactly what the platform sends.

---

## Configuration (values.yaml)

```yaml
rbac:

  # Full access — DevOps and infra engineers
  admins:
    - platform: telegram
      id: "123456789"          # Telegram user ID (number, not username)
      name: "Zeeshan"
    - platform: slack
      id: "U01ABC123"          # Slack user ID (NOT @username)
      name: "Imran"
    - platform: teams
      id: "550e8400-e29b-41d4-a716-446655440000"  # Azure AD object ID
      name: "Khalid"

  # Action access — on-call engineers
  operators:
    - platform: telegram
      id: "987654321"
      name: "On-call"
    - platform: slack
      id: "U02XYZ789"
      name: "SRE Team"

  # Self-service only — non-ops staff
  users:
    - platform: whatsapp
      phone: "+6512345678"     # E.164 format, must match Twilio From header
      name: "Sarah Jones"
      awsUsername: "sarah.jones"   # for /reset password command
    - platform: telegram
      id: "111222333"
      name: "John Smith"
      awsUsername: "john.smith"
    - platform: slack
      id: "U03ABC456"
      name: "Finance Team"
      awsUsername: "finance.shared"

  # Same person on multiple platforms → list twice, same role
  # Example: Zeeshan uses both Telegram and Slack as admin:
  # Already covered above — two separate entries under admins[]
```

**How to find your Telegram user ID:**
Send a message to [@userinfobot](https://t.me/userinfobot) on Telegram — it replies with your numeric ID.

**How to find your Slack user ID:**
In Slack: click your profile → "Copy member ID" → starts with `U`.

---

## Message Flow — End to End

### Admin sends `/restart backend` on Telegram

```
1. Telegram adapter
   ctx.from.id = "123456789", ctx.message.text = "/restart backend"
   → CallerIdentity { platform: 'telegram', id: '123456789', ... }

2. RBAC lookup
   rbac.getRole('telegram', '123456789') → 'admin'

3. Command router
   '/restart' + role 'admin' → restart.cmd.ts ✅ allowed

4. restart.cmd.ts
   → Sends confirmation prompt to Telegram:
     "⚠️ Restart jcp-blo-backend-hubs20-production?
      Reply /yes to confirm or /no to cancel. (60s timeout)"

5. Admin replies /yes
   → kubectl rollout restart deployment/jcp-blo-backend-hubs20-production -n prod

6. Response formatter (admin mode)
   → Technical response:
     "✅ Rolling restart triggered.
      Deployment: jcp-blo-backend-hubs20-production
      Pods restarting: jcp-blo-backend-7d9f4b-xk2p → Terminating
      Expected ready in: ~120s"

7. Audit log
   { user: 'Zeeshan', role: 'admin', platform: 'telegram',
     command: 'restart', target: 'jcp-blo-backend-hubs20-production',
     outcome: 'success', ts: '2026-03-14T08:32:11Z' }

8. Notification router (optional)
   → Sends notification to Slack #ops-alerts:
     "🔄 Restart triggered by Zeeshan: jcp-blo-backend-hubs20-production"
```

---

### Sarah sends "reset my password" on WhatsApp

```
1. WhatsApp adapter
   From: "+6512345678", Body: "reset my password"
   → CallerIdentity { platform: 'whatsapp', id: '+6512345678', ... }

2. RBAC lookup
   rbac.getRole('whatsapp', '+6512345678') → 'user'
   user.awsUsername = 'sarah.jones' ✅

3. NLP parser (user role)
   "reset my password" → matches keyword 'reset' + 'password'
   → reset-password.cmd.ts

4. reset-password.cmd.ts
   → generateSecurePassword() → "Xk9#mP2qLv4@Yw7!"
   → iam.updateLoginProfile({
       UserName: 'sarah.jones',
       Password: 'Xk9#mP2qLv4@Yw7!',
       PasswordResetRequired: true
     })

5. Response formatter (user mode — WhatsApp = no markdown)
   DM to Sarah:
   "✅ Done! Your temporary AWS password:
    Xk9#mP2qLv4@Yw7!
    ⚠️ You must change this on first login.
    (This action has been logged)"

   Public note (if in group chat, sent to group):
   "✅ Password reset done. Details sent to you privately."

6. Audit log
   { user: 'Sarah Jones', role: 'user', platform: 'whatsapp',
     command: 'reset-password', awsUser: 'sarah.jones',
     outcome: 'success', ts: '2026-03-14T09:15:33Z' }
```

---

### Pod crashes at 3AM — who gets notified?

```
1. PodMonitor detects
   user-management-be-production → CrashLoopBackOff
   severity: critical
   service: userFacing: true, friendlyName: "Login"

2. NotificationRouter.route('critical', details, service)

   → Admin DMs (all platforms they're configured on):
     Telegram DM to Zeeshan:
     "🔴 CRITICAL — user-management-be-production
      Status: CrashLoopBackOff (5 restarts in 10 min)
      Node: ip-10-50-1-45 | Namespace: prod
      [AI diagnose running...]"

   → Operator DMs:
     Same technical message

   → Slack #ops-alerts:
     Same technical message

   → User WhatsApp DMs (userFacing: true):
     Sarah: "⚠️ The Login service is currently unavailable.
             Our team has been notified and is working on it.
             We'll update you when it's resolved. ⏰ 3:14 AM"

3. BLUE.Y auto-diagnoses (admin + operator only)
   AI analysis → "OOMKill due to memory spike during nightly Doris sync..."

4. Service recovers (10 min later)
   → Admins + Operators: "✅ Recovered: user-management-be-production (10m 23s)"
   → Users: "✅ Login service is back and working normally. Sorry for the disruption."
```

---

## /status Response Comparison

**Admin sees:**
```
🟢 Cluster: 14/14 pods running
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
jcp-blo-backend-hubs20-production   1/1 ✅  CPU: 420m  Mem: 9.1GB  (50%)
jcp-blo-frontend-fund-update        2/2 ✅  CPU: 45m   Mem: 210MB  (41%)
user-management-be-production       1/1 ✅  CPU: 12m   Mem: 89MB   (17%)
pdf-service-pdf-production          1/1 ✅  CPU: 5m    Mem: 120MB  (6%)
Nodes: 3 healthy | CPU 34% | Mem 61%
```

**Regular user sees:**
```
✅ All systems are running normally.

Services:
  Main platform  ✅
  Login          ✅
  Reports        ✅

Last checked: 2:04 PM SGT
```

---

## Code Structure

```
src/
├── rbac.ts                    # Role lookup, role check, identity normalization
│   ├── RBACConfig             # Loaded from values.yaml
│   ├── getRole(platform, id)  # Returns 'admin' | 'operator' | 'user' | null
│   ├── getUser(platform, id)  # Returns full user config including awsUsername
│   └── isAllowed(role, cmd)   # Permission check for a command
│
├── command-router.ts          # Routes incoming message → correct handler
│   ├── route(identity, msg)   # Main router — parses command, checks RBAC
│   └── parseNLP(msg)          # For user role: keyword → command mapping
│
├── response-formatter.ts      # Formats the same data differently per role
│   ├── formatStatus(data, role)
│   ├── formatIncidents(data, role)
│   └── formatAlert(alert, role)  # technical vs plain English
│
├── notification-router.ts     # Sends alerts to the right people
│   ├── route(severity, msg, service?)
│   └── notifyUsers(friendlyMsg)  # For user-facing service events
│
├── commands/
│   ├── admin/
│   │   ├── waf.cmd.ts
│   │   ├── scan.cmd.ts
│   │   └── email.cmd.ts
│   ├── shared/              # Admin + Operator (role passed to formatter)
│   │   ├── status.cmd.ts
│   │   ├── logs.cmd.ts
│   │   ├── restart.cmd.ts
│   │   ├── incidents.cmd.ts
│   │   └── diagnose.cmd.ts
│   └── user/
│       ├── reset-password.cmd.ts
│       ├── ping.cmd.ts
│       └── status-simple.cmd.ts
│
└── adapters/                # Normalize each platform → CallerIdentity
    ├── telegram.adapter.ts
    ├── slack.adapter.ts
    ├── teams.adapter.ts
    └── whatsapp.adapter.ts
```

---

## Security Notes

- **Unknown callers** receive: `"You are not registered with BLUE.Y. Contact your DevOps team."` — no further info
- **Rate limiting** per user: max 20 commands/hour for admins, 5/hour for users
- **Password reset rate limit**: max 3 resets per user per 24 hours
- **Audit log**: every command recorded with user, role, platform, command, target, outcome, timestamp
- **Sensitive responses** (passwords) always sent via **DM only** — never in group channels
- **Operator cannot silence alerts** — only admin can use `/sleep`/`/wake`

---

*Last updated: 2026-03-14 | Jira: HUBS-6145, HUBS-6149*
