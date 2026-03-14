# BLUE.Y — Integration Setup Wizard

> **Design spec for the first-run setup wizard.**
> Covers all four supported messaging platforms.

---

## Design Philosophy

**Never ask a user to manually copy tokens if a better UX exists.**

| Bad (industry norm) | Good (BLUE.Y wizard) |
|---------------------|----------------------|
| Go to developer portal | Click one button |
| Create an application | OAuth handles the rest |
| Copy Client ID | Auto-detected |
| Copy Client Secret | Stored automatically in K8s Secret |
| Set webhook URL | Socket Mode — no URL needed |
| Pray you didn't typo | Connection test is automatic |

---

## Entry Points

### Option 1 — CLI (for DevOps installing via Helm)
```bash
npx @bluey-ai/setup
```
- Detects your K8s cluster automatically (`kubectl config current-context`)
- Opens setup wizard in browser automatically
- Generates `values.yaml` on completion

### Option 2 — Web UI (first-run on new install)
BLUE.Y serves the wizard on port 3000 when no integration is configured:
```bash
kubectl port-forward pod/blue-y 3000:3000 -n prod
# then open: http://localhost:3000/setup
```

### Option 3 — Update existing install
```bash
npx @bluey-ai/setup --update
# or visit http://localhost:3000/setup on a running instance
```

---

## Platform Selection Screen

```
┌──────────────────────────────────────────────┐
│  🤖 BLUE.Y Setup                            │
│  ─────────────────────────────────────────  │
│                                              │
│  Step 1: Where should BLUE.Y reach you?     │
│                                              │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐    │
│  │ 📱       │ │ 💬       │ │ 🏢       │    │
│  │ Telegram │ │  Slack   │ │  Teams   │    │
│  │          │ │          │ │          │    │
│  │ 2 min    │ │ 1 click  │ │ 3 clicks │    │
│  │ easiest  │ │ OAuth    │ │ manifest │    │
│  └──────────┘ └──────────┘ └──────────┘    │
│                                              │
│  ┌──────────┐  ┌──────────────────────┐     │
│  │ 📱       │  │ ☑ Use multiple       │     │
│  │ WhatsApp │  │   platforms          │     │
│  │          │  │   (recommended)      │     │
│  │ QR scan  │  └──────────────────────┘     │
│  └──────────┘                               │
└──────────────────────────────────────────────┘
```

> **Recommendation**: Enable Telegram or Slack for DevOps/Admins, WhatsApp for regular users.

---

## Telegram Setup — 3 Steps (~2 minutes)

### Why Telegram is easiest
- No OAuth server needed
- BLUE.Y polls Telegram API (no public URL required)
- Chat ID is auto-detected when user sends first message

### Click flow

```
Wizard Screen                           User Action
─────────────────────────────────────   ──────────────────────────────────
Step 1: Create your bot

  [Open BotFather ↗]                  → Clicks → Telegram opens
  (deep link: tg://resolve?            → Sends: /newbot
   domain=BotFather)                   → Follows prompts (picks name)
                                        → BotFather replies with token

  "Paste your bot token:"
  ┌──────────────────────────┐
  │ 1234567890:AAXXXXXX...   │ [Validate →]
  └──────────────────────────┘         → Pastes token → clicks Validate

  ✅ Token valid! Bot: @YourBotName

─────────────────────────────────────
Step 2: Connect your chat

  "Now send any message to your bot:"
  @YourBotName                        → Opens Telegram, sends "hello"

  ⏳ Waiting for your message...
  (auto-polls every 2 seconds)

  ✅ Got it! Message from: Alice    (auto-advances to step 3)

─────────────────────────────────────
Step 3: Add your team (→ shared with all platforms, see below)
```

### What happens behind the scenes
1. Wizard calls `GET /bot{token}/getUpdates` every 2 seconds
2. First message received → extracts `chat.id` automatically
3. Stores token + chatId in K8s Secret (`blue-y-secrets`)
4. Sends test message: "👋 BLUE.Y is connected! Type /help to get started."

### No public URL needed ✅
BLUE.Y uses **long polling** — it reaches out to Telegram, Telegram never needs to reach back.

---

## Slack Setup — 2 Clicks via OAuth

### Why OAuth
No manual token copying. Same experience as adding any Slack app (GitHub, Jira, etc.).
Uses **Socket Mode** — BLUE.Y opens a WebSocket to Slack; no public URL or webhook needed.

### Click flow

```
Wizard Screen                           User Action
─────────────────────────────────────   ──────────────────────────────────
Step 1: Connect Slack

  ┌──────────────────────────────────┐
  │  [Add to Slack ↗]               │  → Clicks
  └──────────────────────────────────┘     → Slack OAuth page opens
                                            → User selects workspace
                                            → Clicks [Allow]
                                            → Redirects back to wizard

  ✅ Connected to: Your Workspace Slack
  (token stored automatically)

─────────────────────────────────────
Step 2: Pick your alert channel

  "Where should BLUE.Y send alerts?"

  ┌──────────────────────────────────┐
  │  # ops-alerts              ▼     │  → Selects from real channel list
  └──────────────────────────────────┘     (wizard fetches channels via API)

  [Continue →]                        → Clicks

  ✅ Test message sent to #ops-alerts!

─────────────────────────────────────
Step 3: Add your team (→ shared, see below)
```

### What happens behind the scenes
1. Wizard serves OAuth callback at `http://localhost:3000/oauth/slack/callback`
2. After approval, Slack sends `bot_access_token` + `app_token` to callback
3. Both tokens stored in K8s Secret
4. Wizard fetches channel list via `conversations.list` API → shows dropdown
5. Sends test message via `chat.postMessage`

### No public URL needed ✅
OAuth callback is on `localhost` (the user's machine running `npx @bluey-ai/setup`).
After setup, BLUE.Y uses Socket Mode — outbound WebSocket only.

### Slash commands available after setup
```
/bluey status       — cluster health
/bluey logs <pod>   — pod logs
/bluey restart <x>  — rolling restart (with confirm button)
/bluey scan <repo>  — security scanner
/bluey load         — load monitor summary
/bluey waf          — WAF dashboard
/bluey incidents    — recent incidents
/bluey help         — role-aware help
```
Confirmations use Slack Block Kit buttons (not text `/yes`):
```
┌─────────────────────────────────────────┐
│ ⚠️ Restart backend-production?          │
│ This will cause ~30s rolling restart.   │
│ [✅ Confirm]  [❌ Cancel]               │
└─────────────────────────────────────────┘
```

---

## MS Teams Setup — 3 Steps (~10 minutes)

### Why manifest-based
Teams requires app registration but BLUE.Y generates the entire manifest automatically.
No Azure portal needed. The wizard creates a Teams-installable `.zip` in one click.

### Click flow

```
Wizard Screen                           User Action
─────────────────────────────────────   ──────────────────────────────────
Step 1: Create your bot registration

  "We need a quick Azure Bot setup."
  "It's free and takes 2 minutes."

  [Open Azure Bot Setup ↗]             → Clicks → Azure portal opens
  (wizard shows animated GIF of          (pre-filled URL with defaults)
   exactly where to click)

  "Paste your App ID and Secret:"
  ┌──────────────────────────────────┐
  │ App ID:     [________________]   │
  │ App Secret: [________________]   │  → Pastes both
  └──────────────────────────────────┘
  [Continue →]

─────────────────────────────────────
Step 2: Install to Teams

  "Your Teams app is ready to install"

  [Download & Install to Teams ↗]     → Clicks
                                         → msteams:// deep link opens Teams
                                            directly at "Upload an app"
                                         → User clicks Install
                                         → Adds to ops team/channel

─────────────────────────────────────
Step 3: Connect

  "Go to your ops channel and send:"
  @BLUE.Y hello                        → Sends message in Teams

  ⏳ Waiting for your message...
  (polls every 3 seconds)

  ✅ Connected to: #ops-general        (auto-advances)
```

### Auto-generated manifest (inside the .zip)
```json
{
  "manifestVersion": "1.14",
  "id": "<app-id-from-azure>",
  "name": {
    "short": "BLUE.Y",
    "full": "BLUE.Y AI Ops Assistant"
  },
  "description": {
    "short": "AI-powered Kubernetes monitoring",
    "full": "24/7 cluster monitoring, incident response, and self-service ops via Teams"
  },
  "bots": [{
    "botId": "<app-id-from-azure>",
    "scopes": ["personal", "team", "groupChat"],
    "commandLists": [{
      "scopes": ["team"],
      "commands": [
        { "title": "status", "description": "Cluster health overview" },
        { "title": "logs", "description": "Pod logs" },
        { "title": "incidents", "description": "Recent incidents" },
        { "title": "help", "description": "Show all commands" }
      ]
    }]
  }],
  "validDomains": ["<bluey-host>"]
}
```

### Commands in Teams
```
@BLUE.Y status          — Adaptive Card with pod/node grid
@BLUE.Y logs backend    — Code block with last 50 lines
@BLUE.Y restart backend — Adaptive Card with Confirm/Cancel buttons
@BLUE.Y incidents       — Recent incidents card
@BLUE.Y help            — Role-aware command list
```

### Adaptive Card example (status response)
```
┌──────────────────────────────────────┐
│ 🟢 Cluster Status           [Refresh]│
├──────────────────────────────────────┤
│ backend-production    2/2  ✅        │
│ frontend-production   2/2  ✅        │
│ user-mgmt-production  1/1  ✅        │
│ pdf-service           1/1  ✅        │
├──────────────────────────────────────┤
│ CPU: 34%    Memory: 61%    Nodes: 3  │
└──────────────────────────────────────┘
```

---

## WhatsApp Setup — Scan QR Code (~5 minutes)

### Two modes

| Mode | Setup time | Good for |
|------|-----------|----------|
| **Sandbox** (Twilio) | 2 min | Testing, small teams |
| **Production** (Twilio) | 1–3 weeks | Company-wide rollout |

The wizard starts with Sandbox and provides a guided upgrade path to Production.

### Click flow

```
Wizard Screen                           User Action
─────────────────────────────────────   ──────────────────────────────────
Step 1: Connect via QR

  "Scan this with WhatsApp:"

  ┌──────────────────────┐
  │   ▄▄▄▄▄  ▄  ▄▄▄▄▄   │
  │   █   █ ▄▄▄ █   █   │  → Opens WhatsApp → Camera → Scans
  │   █▄▄▄█     █▄▄▄█   │     → WhatsApp opens chat with BLUE.Y
  │   ▄ ▄ ▄ ▄▄▄ ▄ ▄ ▄   │     → Sends the join code (auto-typed)
  │   ▄▄▄▄▄  ▄  ▄▄▄▄▄   │
  └──────────────────────┘
  (Twilio sandbox QR code)

  ⏳ Waiting for your message...

  ✅ Connected! +65 9123 4567

─────────────────────────────────────
Step 2: Add team members

  "Add people who can message BLUE.Y:"

  ┌──────────────────────────────────┐
  │ +65 9876 5432  John   (user) ✅ │
  │ +60 1234 5678  Sarah  (user) ✅ │
  │ [+ Add member]                   │  → Enters phone numbers + names
  └──────────────────────────────────┘     + their AWS username (optional)
                                            for password reset feature

  [Send invites]                      → Clicks
                                         → Wizard sends each person:
                                           "Hi John! Scan this to connect
                                            with BLUE.Y 👇" + their QR

─────────────────────────────────────
Step 3: Production upgrade (optional)

  "For company-wide use, connect your
   own WhatsApp Business number."

  [Upgrade to Production →]          → Guided Twilio Business setup
  [Skip for now]
```

### What WhatsApp users can do (user role only)
WhatsApp has no slash commands — users send natural language:

| Message | Response |
|---------|----------|
| `status` or `is everything ok?` | "✅ All systems running normally." |
| `reset my password` | Generates temp password, sends via DM |
| `any incidents?` | Plain English summary of recent outages |
| `ping login` | "✅ Login service is reachable." |
| `help` | Lists what the user can ask |

WhatsApp formatting = plain text + emojis only. No code blocks, no pod names, no K8s jargon.

### Cost (shown in wizard before setup)
```
Twilio WhatsApp pricing:
  - $0.005 per message sent
  - $0.005 per message received

Typical usage (50 users, 5 messages/day):
  ≈ $1.50/day ≈ $45/month

This cost appears on your Twilio bill, not BLUE.Y.
```

---

## Step 3 (Shared): Add Your Team

This step is identical for all platforms:

```
┌──────────────────────────────────────────────┐
│  Who's on your team?                         │
│  ─────────────────────────────────────────   │
│                                              │
│  ADMINS  (full cluster access)               │
│  ┌────────────────────────────────────────┐  │
│  │ @alice (you)      DevOps Admin   ✅    │  │
│  │                                        │  │
│  │ [+ Add admin]                          │  │
│  │   Enter their Telegram username /      │  │
│  │   Slack handle / Teams email           │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  OPERATORS  (can restart/scale, not WAF)     │
│  ┌────────────────────────────────────────┐  │
│  │ [+ Add operator]                       │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  REGULAR USERS  (status + password reset)    │
│  ┌────────────────────────────────────────┐  │
│  │ +65 9123 4567  Sarah   sarah.jones ✅  │  │
│  │  Phone         Name    AWS username    │  │
│  │                                        │  │
│  │ [+ Add user]                           │  │
│  └────────────────────────────────────────┘  │
│                                              │
│  [Finish & Install →]                        │
└──────────────────────────────────────────────┘
```

**How BLUE.Y finds a user's ID automatically:**
- Telegram: wizard sends them a message, captures their ID
- Slack: wizard uses Slack API to look up by email
- Teams: maps Azure AD email → object ID via Graph API
- WhatsApp: phone number IS the identity

---

## Final Screen: Install

```
┌──────────────────────────────────────────────┐
│  🎉 BLUE.Y is configured!                   │
│  ─────────────────────────────────────────  │
│                                              │
│  ✅ Telegram connected (@YourBotName)        │
│  ✅ Slack connected   (#ops-alerts)          │
│  ✅ 1 admin, 2 users configured             │
│  ✅ Connection test passed                   │
│                                              │
│  To install on your cluster:                 │
│                                              │
│  ┌────────────────────────────────────┐      │
│  │ helm install blue-y bluey/blue-y   │      │
│  │   -f values.yaml                   │ [📋] │
│  └────────────────────────────────────┘      │
│                                              │
│  [Download values.yaml]                      │
│  [Download K8s secrets manifest]             │
│                                              │
│  ─────────────────────────────────────────  │
│  Already installed? Update your config:      │
│  ┌────────────────────────────────────┐      │
│  │ helm upgrade blue-y bluey/blue-y   │      │
│  │   -f values.yaml                   │ [📋] │
│  └────────────────────────────────────┘      │
│                                              │
│  BLUE.Y will send you a welcome message      │
│  on each connected platform now.             │
└──────────────────────────────────────────────┘
```

---

## Generated Output

### values.yaml (safe to commit to git)
```yaml
# Generated by BLUE.Y Setup Wizard — 2026-03-14
# Secrets are stored separately in K8s Secret 'blue-y-secrets'

cluster:
  name: my-eks-cluster        # your EKS cluster name
  region: us-east-1           # your AWS region
  namespace: default          # namespace where BLUE.Y is deployed

integrations:
  telegram:
    enabled: true
    chatId: "-1001234567890"          # auto-detected from first message
  slack:
    enabled: true
    alertChannel: "#ops-alerts"
    socketMode: true                  # no public URL needed
  teams:
    enabled: false
  whatsapp:
    enabled: true
    provider: twilio
    fromNumber: "+14155238886"

rbac:
  admins:
    - platform: telegram
      id: "123456789"
      name: "Alice"
    - platform: slack
      id: "U01ABC123"
      name: "Bob"
  operators: []
  users:
    - platform: whatsapp
      phone: "+6512345678"
      name: "Sarah"
      awsUsername: "sarah.jones"
    - platform: whatsapp
      phone: "+6598765432"
      name: "John"
      awsUsername: "john.smith"
```

### K8s secrets manifest (DO NOT commit — apply once, then delete)
```yaml
apiVersion: v1
kind: Secret
metadata:
  name: blue-y-secrets
  namespace: prod
type: Opaque
stringData:
  telegram-bot-token: "1234567890:AAXXXXXXXXXXXXXXXXXXXXXX"
  slack-bot-token: "xoxb-XXXXXXXXXXXX-XXXXXXXXXXXX-XXXXXXXXXXXXXXXXXXXXXXXX"
  slack-app-token: "xapp-1-XXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  twilio-account-sid: "ACXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  twilio-auth-token: "XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
  deepseek-api-key: "sk-XXXXXXXXXXXXXXXXXXXX"
  jira-api-token: "XXXXXXXXXXXXXXXXXXXXXXXX"
```

---

## Public URL Requirements

| Platform | Needs Public URL | How Wizard Handles It |
|----------|-----------------|----------------------|
| Telegram | ❌ No | Long polling — outbound only |
| Slack | ❌ No | Socket Mode — outbound WebSocket |
| Teams | ✅ Yes | Uses cluster's existing ALB ingress |
| WhatsApp | ✅ Yes | Uses cluster's existing ALB ingress |

For Teams and WhatsApp: wizard auto-detects the cluster's ingress URL:
```bash
kubectl get ingress -n <namespace> -o jsonpath='{.items[0].spec.rules[0].host}'
# → your-cluster-ingress.example.com
```
If no ingress exists, wizard offers a temporary tunnel option (localtunnel).

---

## Troubleshooting

### Telegram: "Bot not found"
Token format must be `{numbers}:{letters}`. No spaces. Get a fresh token from @BotFather if expired.

### Slack: "OAuth redirect failed"
The wizard must be running locally (`npx @bluey-ai/setup`) for OAuth to work.
The OAuth redirect URI is `http://localhost:3000/oauth/slack/callback`.

### Teams: "Manifest upload rejected"
Ensure the app ID in the manifest matches your Azure Bot App ID exactly.
Teams requires HTTPS — use your cluster's ALB ingress, not localhost.

### WhatsApp: "Messages not received"
In Twilio Console → WhatsApp Sandbox, ensure the webhook URL is set:
```
POST https://<your-bluey-host>/whatsapp/incoming
```
The sandbox also requires users to send the join code first (one-time).

---

*Last updated: 2026-03-14*
