# BLUE.Y — Setup Guide

Get BLUE.Y running on your Kubernetes cluster in 15 minutes.

---

## Quickstart (Helm — recommended)

```bash
helm repo add bluey https://bluey-ai.github.io/blue.y
helm repo update

helm install blue-y bluey/blue-y \
  --namespace prod --create-namespace \
  --set telegram.botToken=YOUR_TOKEN \
  --set telegram.chatId=YOUR_CHAT_ID \
  --set ai.apiKey=YOUR_DEEPSEEK_KEY \
  --set kube.clusterName=my-cluster \
  --set kube.awsRegion=ap-southeast-1
```

That's it. Send `/help` to your Telegram bot.

---

## Step-by-step: Getting Your Keys

### 1. Telegram Bot Token + Chat ID

**Bot Token:**
1. Open Telegram → search `@BotFather`
2. Send `/newbot`
3. Choose a name (e.g. `My Cluster Bot`) and username (e.g. `mycluster_bot`)
4. BotFather replies with your token: `123456789:ABCdef...` → this is your `telegram.botToken`

**Chat ID:**
1. Create a Telegram group and add your bot to it
2. Send any message in the group
3. Open this URL in your browser (replace TOKEN):
   `https://api.telegram.org/botTOKEN/getUpdates`
4. Look for `"chat":{"id":` — the number (may be negative) is your `telegram.chatId`

> **Tip:** Use a dedicated group for cluster alerts, not a personal chat.

---

### 2. DeepSeek API Key (AI engine)

1. Go to [platform.deepseek.com](https://platform.deepseek.com)
2. Sign up / log in
3. Go to **API Keys** → **Create new key**
4. Copy the key → this is your `ai.apiKey`

> DeepSeek is ~30× cheaper than GPT-4 and performs equally well for ops tasks.
> Cost: ~$0.001 per incident diagnosis.

---

### 3. Jira API Token (optional — for `/jira` command)

1. Go to [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens)
2. Click **Create API token** → give it a label (e.g. `blue-y`)
3. Copy the token → this is your `jira.apiToken`
4. Your `jira.email` is the Atlassian account email you logged in with
5. Your `jira.baseUrl` is `https://YOUR-ORG.atlassian.net`

---

### 4. Slack Bot + App Token (optional — for Slack alerts)

1. Go to [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From scratch**
2. Under **OAuth & Permissions** → add Bot Token Scopes:
   `chat:write`, `channels:read`, `groups:read`
3. Click **Install to Workspace** → copy the **Bot User OAuth Token** (`xoxb-...`) → `slack.botToken`
4. Under **Socket Mode** → enable it → generate an **App-Level Token** with scope `connections:write` (`xapp-...`) → `slack.appToken`
5. Invite the bot to your channel: `/invite @your-bot-name`
6. Copy the channel ID from the channel URL → `slack.channelId`

---

### 5. AWS IRSA Role (optional — for Bedrock AI, WAF, SES)

If you want BLUE.Y to use AWS services (Bedrock for AI, WAF monitoring, SES email):

```bash
# Create IAM role with trust policy for your service account
eksctl create iamserviceaccount \
  --name blue-y \
  --namespace prod \
  --cluster YOUR_CLUSTER \
  --attach-policy-arn arn:aws:iam::aws:policy/AmazonBedrockFullAccess \
  --approve

# Get the role ARN
aws iam get-role --role-name eksctl-blue-y-sa --query 'Role.Arn' --output text
```

Set the ARN as `serviceAccount.irsaRoleArn` in your values.

---

## Full values.yaml example

Save this as `my-values.yaml` and run `helm install blue-y bluey/blue-y -f my-values.yaml`:

```yaml
telegram:
  botToken: "123456789:ABCdefGHIjklMNOpqrSTUvwxYZ"
  chatId: "-1001234567890"

ai:
  apiKey: "sk-xxxxxxxxxxxxxxxxxxxxxxxx"
  systemContext: "Cluster: prod. Main apps: backend (prod ns), frontend (prod ns)."

kube:
  clusterName: "my-eks-cluster"
  awsRegion: "us-east-1"
  watchNamespaces: "prod,staging,monitoring"

# Optional: Jira
jira:
  baseUrl: "https://mycompany.atlassian.net"
  projectKey: "OPS"
  email: "devops@mycompany.com"
  apiToken: "ATATT3xFfGF0..."

# Optional: Slack
slack:
  botToken: "xoxb-..."
  appToken: "xapp-..."
  channelId: "C0XXXXXXXXX"
```

---

## Verify it's working

```bash
# Check the pod is running
kubectl get pods -n prod -l app=blue-y

# Watch logs
kubectl logs -f deployment/blue-y-production -n prod

# Send a test command on Telegram
/status
```

---

## Upgrade

```bash
helm repo update
helm upgrade blue-y bluey/blue-y --reuse-values
```

---

## Uninstall

```bash
helm uninstall blue-y -n prod
```

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Bot not responding | Check `telegram.botToken` and `telegram.chatId` are correct |
| `ImagePullBackOff` | The image tag may not exist yet — use `tag: latest` |
| AI diagnosis not working | Verify `ai.apiKey` is valid at platform.deepseek.com |
| Pod crashing | Run `kubectl logs deployment/blue-y-production -n prod` |

More help: [github.com/bluey-ai/blue.y/issues](https://github.com/bluey-ai/blue.y/issues)
