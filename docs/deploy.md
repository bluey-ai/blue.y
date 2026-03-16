# Deploying BLUE.Y to Your Kubernetes Cluster

This guide gets you from zero to a running BLUE.Y pod in under 15 minutes.

## Prerequisites

- AWS account with EKS cluster running
- ECR repository named `blue-y` in your account
- `kubectl` configured and pointing at your cluster
- GitHub repository forked from `bluey-ai/blue.y`

---

## Step 1 — Create the K8s Secret

BLUE.Y reads all sensitive config from a single Kubernetes secret. Run this once:

```bash
kubectl create secret generic blue-y-secrets \
  --namespace prod \
  --from-literal=deepseek-api-key=YOUR_DEEPSEEK_API_KEY \
  --from-literal=telegram-bot-token=YOUR_TELEGRAM_BOT_TOKEN \
  --from-literal=telegram-chat-id=YOUR_TELEGRAM_CHAT_ID \
  --from-literal=jira-email=you@yourcompany.com \
  --from-literal=jira-api-token=YOUR_JIRA_API_TOKEN
```

> Only `deepseek-api-key` and `telegram-bot-token` + `telegram-chat-id` are required to get started.
> Everything else is optional.

---

## Step 2 — Set GitHub Secrets

In your GitHub repo → **Settings → Secrets and variables → Actions**, add:

| Secret | Value |
|--------|-------|
| `AWS_ACCOUNT_ID` | Your AWS account ID (e.g. `123456789012`) |
| `AWS_REGION` | Your AWS region (e.g. `ap-southeast-1`) |
| `EKS_CLUSTER_NAME` | Your EKS cluster name (e.g. `my-cluster`) |
| `K8S_NAMESPACE` | Kubernetes namespace (e.g. `prod`) |
| `AWS_ROLE_ARN` | IAM role ARN for GitHub OIDC (see Step 3) |

---

## Step 3 — IAM Role for GitHub Actions (OIDC)

Create an IAM role that GitHub Actions can assume. This is more secure than access keys.

```bash
# Create the trust policy
cat > trust-policy.json << 'EOF'
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": {
      "Federated": "arn:aws:iam::YOUR_ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com"
    },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:YOUR_GITHUB_ORG/blue.y:*"
      }
    }
  }]
}
EOF

# Create the role
aws iam create-role \
  --role-name BlueYGitHubDeploy \
  --assume-role-policy-document file://trust-policy.json

# Attach required policies
aws iam attach-role-policy \
  --role-name BlueYGitHubDeploy \
  --policy-arn arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser

aws iam attach-role-policy \
  --role-name BlueYGitHubDeploy \
  --policy-arn arn:aws:iam::aws:policy/AmazonEKSClusterPolicy
```

Set `AWS_ROLE_ARN` secret to `arn:aws:iam::YOUR_ACCOUNT_ID:role/BlueYGitHubDeploy`.

> **Prefer access keys?** Set `vars.USE_OIDC = false` (repo variable, not secret), then add
> `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` secrets instead.

---

## Step 4 — Deploy

Push a version tag to trigger the pipeline:

```bash
git tag v1.4.1
git push origin v1.4.1
```

Or trigger manually: **GitHub → Actions → Deploy to Kubernetes → Run workflow**.

Watch the rollout:

```bash
kubectl rollout status deployment/blue-y-production -n prod
kubectl logs -f deployment/blue-y-production -n prod
```

---

## Verify

Send `/help` to your Telegram bot. You should see the BLUE.Y command menu.

---

## Helm (Alternative)

Prefer Helm? See [Helm chart setup](../helm/blue-y/README.md) or install directly:

```bash
helm repo add bluey https://bluey-ai.github.io/blue.y
helm install blue-y bluey/blue-y \
  --namespace prod --create-namespace \
  --set telegram.botToken=YOUR_TOKEN \
  --set telegram.chatId=YOUR_CHAT_ID \
  --set ai.apiKey=YOUR_DEEPSEEK_KEY
```
