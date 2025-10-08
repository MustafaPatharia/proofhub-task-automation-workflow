# ProofHub Task Automation Script

Automatically update ProofHub task stages when Pull Requests are merged, with intelligent parent-subtask relationship handling.

## 🚀 Features

- ✅ Automatically updates task stages based on target branch
- 👨‍👩‍👧‍👦 Intelligent parent-subtask relationship handling
- 🔒 Forward-only stage movement protection
- 🎯 Fully customizable via JSON configuration
- 📊 Detailed execution reporting
- 🔧 Generic and reusable across projects

## 📋 Prerequisites

- Node.js (v14 or higher)
- ProofHub account with API access
- GitHub repository with Actions enabled

## ⚙️ Configuration

### 1. config.json File

This file contains your ProofHub project settings and stage configurations. **Keep this file in your repository** (it doesn't contain sensitive data).

#### Configuration Sections:

**`proofhub`**: Your ProofHub project details
- `apiUrl`: ProofHub API base URL (usually `https://api.proofhub.com` or your custom domain)
- `projectId`: Your project ID (see "How to Get IDs" section)
- `todoListId`: Your task list ID

**`stages`**: Maps Git branches to ProofHub stages
- Key: Git branch name (e.g., `"development"`, `"main"`, `"release/dev"`)
- `targetStage`: Name of the ProofHub stage
- `targetStageId`: ID of the ProofHub stage

**`stageHierarchy`**: Defines stage order for forward-only movement
- Higher numbers = later stages in workflow
- Prevents moving tasks backward (e.g., from "QA Testing" to "In Progress")

**`parentRules`**: Defines how parent tasks should move based on subtask states
- `parentStage`: The current stage of the parent task
- `actions`: Array of rules to check
  - `condition`: `"some"` (at least one subtask) or `"all"` (all subtasks)
  - `subtaskStage`: The subtask stage to check for
  - `moveParentTo`: Where to move the parent task

**`features`**: Feature toggles
- `parentRulesEnabled`: Enable/disable parent-subtask automation

### 2. Environment Variables (GitHub Secrets)

Set these in your GitHub repository secrets. **These should NEVER be committed to your repository.**

| Variable | Description | Required |
|----------|-------------|----------|
| `PROOFHUB_API_KEY` | Your ProofHub API key | ✅ Yes |
| `TARGET_BRANCH` | Target branch (auto-set by GitHub Actions) | ✅ Yes |
| `PR_BODY` | PR description content (auto-set by GitHub Actions) | ✅ Yes |
| `PR_NUMBER` | PR number (auto-set by GitHub Actions) | ✅ Yes |

## 🔧 GitHub Actions Integration

Create `.github/workflows/proofhub-automation.yml`:

```yaml
name: ProofHub Task Automation

on:
  pull_request:
    types: [closed]
    branches:
      - main
      - development
      - staging
      - 'release/**'

jobs:
  update-tasks:
    if: github.event.pull_request.merged == true
    runs-on: ubuntu-latest

    steps:
      - name: Checkout code
        uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Update ProofHub Tasks
        env:
          PROOFHUB_API_KEY: ${{ secrets.PROOFHUB_API_KEY }}
          TARGET_BRANCH: ${{ github.event.pull_request.base.ref }}
          PR_BODY: ${{ github.event.pull_request.body }}
          PR_NUMBER: ${{ github.event.pull_request.number }}
        run: node proofhub-automation.js
```

## 📝 PR Body Format

Tasks must be listed in your PR description under a specific section:

```markdown
### 📋 ProofHub Tasks

- #1234567890 - Implement user authentication
- #9876543210 - Add password validation
```

**Important**:
- Only added tasks (with) will be processed!
- Task IDs must be 9+ digits
- Must include the `### 📋 ProofHub Tasks` header

## 👨‍👩‍👧‍👦 Parent-Subtask Rules

Configure custom rules in `config.json` under `parentRules`:

### Example Rule Structure:

```json
{
  "parentStage": "To Do",
  "actions": [
    {
      "condition": "some",
      "subtaskStage": "Development Completed",
      "moveParentTo": "In Progress"
    },
    {
      "condition": "all",
      "subtaskStage": "Development Completed",
      "moveParentTo": "Completed"
    }
  ]
}
```

This rule means:
- **When** parent is in "To Do" stage
- **If** some subtasks move to "Development Completed" → move parent to "In Progress"
- **If** all subtasks move to "Development Completed" → move parent to "Development Completed"

### 🔒 Forward-Only Protection

Parents can only move forward in the stage hierarchy defined in `stageHierarchy`.

Example with hierarchy:
```json
{
  "QA Testing": 4,
  "Staging Review": 6
}
```

- ✅ QA Testing → Staging Review (4 → 6, forward)
- ❌ Staging Review → QA Testing (6 → 4, backward, blocked)

## 🎯 How to Get ProofHub IDs

### 1. Get Your API Key
1. Log in to ProofHub
2. Go to **Settings** → **API**
3. Generate a new API key
4. Store it in GitHub Secrets as `PROOFHUB_API_KEY`

### 2. Get Project ID
1. Go to your ProofHub project
2. Check the URL: `https://your-domain.proofhub.com/projects/1234567890`
3. The number after `/projects/` is your `projectId`

### 3. Get Todo List ID
1. Open your task list in ProofHub
2. Check the URL: `https://your-domain.proofhub.com/projects/xxx/todolists/9876543210`
3. The number after `/todolists/` is your `todoListId`

### 4. Get Stage IDs
Use the ProofHub API to fetch your workflow stages:

```bash
curl -H "X-API-Key: YOUR_API_KEY" \
     https://api.proofhub.com/api/v3/projects/PROJECT_ID/workflows
```

Look for your workflow and note down the stage IDs and names.

## 📊 Output Example

```
🚀 ProofHub Task Automation Script

📌 Target Branch: development
🎯 Target Stage: QA Testing
🆔 PR Number: #42

📋 Found 2 added task(s): 1234567890, 9876543210

✅ Task #1234567890 → "QA Testing" (Direct update from PR)
✅ Task #9876543210 → "QA Testing" (Direct update from PR)

👨‍👩‍👧‍👦 Processing 1 parent task(s)...

🔍 Processing parent task #1111111111...
   Parent current stage: To Do
   Found 2 subtask(s)
      - Subtask #1234567890: QA Testing
      - Subtask #9876543210: QA Testing
✅ Task #1111111111 → "QA Testing" (All subtasks in QA Testing)

============================================================
📊 EXECUTION SUMMARY
============================================================
✅ Tasks updated: 2/2
👨‍👩‍👧‍👦 Parent tasks updated: 1/1
============================================================
```

## 🐛 Troubleshooting

#### Issue: Tasks not updating
**Solution**:
1. Verify tasks are added in PR body
2. Check task IDs are correct (9+ digits)
3. Ensure PR body contains `### 📋 ProofHub Tasks` section
4. Verify stage IDs in `config.json` match your ProofHub workflow

#### Issue: Parent task not updating
**Solution**:
1. Check `features.parentRulesEnabled` is `true` in `config.json`
2. Verify parent rules are configured correctly
3. Ensure subtasks have correct `parent_id` in ProofHub
4. Review stage hierarchy for forward-only movement

## 📁 Project Structure

```
your-repo/
├── .github/
│   └── scripts/
│       └── config.json              # Your configuration
│       └── proofhub-automation.js   # Main script
│   └── workflows/
│       └── proofhub-automation.yml
├── .env                    # Local testing only (gitignored)
├── .gitignore              # Ignore .env file
├── indes.js                # starting point
├── package.json
└── README.md
```
## 📄 License

MIT License - feel free to use and modify for your projects!

## 🤝 Contributing

Contributions are welcome! Please feel free to submit issues or pull requests.

---

**Made with ❤️ for better project management automation**