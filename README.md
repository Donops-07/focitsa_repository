# FOCITSA Knowledge Base

A static, serverless faculty resource repository. Students get instant, frictionless access to past questions, lecture notes, and study materials. No Google Drive UI. No folder navigation. No authentication prompts.

**Live site:** `https://focitsa-kb.vercel.app` *(update after first deploy)*

---

## Architecture

```
GitHub Actions (daily @ 02:00 WAT)
    │  Authenticates with Google Drive API (service account — secrets.GOOGLE_SA_KEY)
    │  Crawls folder: 1CjXTm0EW9Z9rGG_f7nfHZva4JIHvp8We
    │  Writes: public/manifest.json + public/manifest.version.json
    ▼
Git Repository → Vercel detects push → redeploys static site
    ▼
Student browser:
  1. Reads localStorage context (level + dept) — skip onboarding on return visit
  2. Web Worker fetches manifest.version.json (80 bytes, always fresh)
  3. Worker checks IndexedDB for cached manifest at current hash
  4. Cache hit → 0 bytes downloaded · Cache miss → 800KB fetched + stored
  5. Fuse.js index built off the main thread
  6. Student types course code → results in <2ms
  7. Preview → in-app iframe modal (no Drive UI)
  8. Download → direct Drive CDN link
```

---

## Project Structure

```
focitsa-kb/
├── public/
│   ├── index.html               # App shell
│   ├── manifest.json            # Auto-generated search index
│   ├── manifest.version.json    # Content hash sidecar
│   └── assets/
│       ├── style.css            # Full design system
│       ├── app.js               # Main thread UI logic
│       └── search.worker.js     # Web Worker (Fuse.js + IndexedDB)
├── scripts/
│   ├── crawl-drive.js           # Node.js crawler
│   └── courses.json             # Canonical course registry
├── .github/
│   └── workflows/
│       └── refresh-manifest.yml # Scheduled + manual CI/CD
├── vercel.json                  # Cache header config
└── package.json
```

---

## Google Drive Folder Structure (Required Schema)

The crawler parses metadata from the folder path. Committee members must follow this schema:

```
FOCITSA_KNOWLEDGE_BASE/          ← root (ID: 1CjXTm0EW9Z9rGG_f7nfHZva4JIHvp8We)
└── 200_LEVEL/                   ← level (200, 300, etc.)
    └── FIRST_SEMESTER/          ← semester (FIRST or SECOND)
        └── COS_201_Discrete_Structures/  ← course folder
            ├── Syllabus/
            │   └── COS201_Syllabus_2024.pdf
            ├── Lecture_Notes/
            │   └── COS201_Notes_Week1.pdf
            ├── Past_Questions/
            │   ├── COS201_PQ_2023.pdf
            │   └── COS201_PQ_2024.pdf
            └── Tutorials/
                └── COS201_Tutorial_Set1.pdf
```

**Accepted naming variations** (the crawler is fuzzy-tolerant):

| Field | Accepted formats |
|---|---|
| Level | `200_LEVEL`, `200L`, `200-Level` |
| Semester | `FIRST_SEMESTER`, `1st_Sem`, `SEM_1` |
| Course | `COS_201_Title`, `COS 201-Title`, `COS201_title` |
| Type | `Past_Questions`, `PQ`, `Lecture_Notes`, `Notes` |
| File | `COS201_PQ_2024.pdf`, `2024_Past_Question.pdf` |

---

## Setup — New Deployment

### Prerequisites
- A GitHub repository
- A Vercel account (free tier is sufficient)
- A Google Cloud project with the Drive API enabled

### Step 1 — Google Service Account

1. Go to [console.cloud.google.com](https://console.cloud.google.com)
2. Create a new project (e.g. `focitsa-kb`)
3. Enable the **Google Drive API**
4. Create a **Service Account** (`crawler@focitsa-kb.iam.gserviceaccount.com`)
5. Grant it **read-only** Drive scope
6. Download the JSON key file
7. **Share your Drive folder** with the service account email (Viewer role)

### Step 2 — GitHub Secrets

In your repository → Settings → Secrets → Actions, add:

| Secret name | Value |
|---|---|
| `GOOGLE_SA_KEY` | The entire contents of the JSON key file |

> The `DRIVE_ROOT_FOLDER_ID` is already baked into the workflow (`1CjXTm0EW9Z9rGG_f7nfHZva4JIHvp8We`). Change it in `.github/workflows/refresh-manifest.yml` if the folder ever moves.

### Step 3 — Deploy to Vercel

```bash
npm install -g vercel
vercel --prod
```

Or connect the repository to Vercel via the dashboard. No build command needed — the `public/` folder is served directly.

### Step 4 — First Crawl

Trigger the first crawl manually:
1. Go to your repository → Actions → **Refresh Search Manifest**
2. Click **Run workflow**

After the crawl completes, Vercel will automatically redeploy with the live manifest.

---

## Adding a New Course

When a new course is added to the faculty:

1. Add it to `scripts/courses.json`:
   ```json
   "COS405": {
     "code": "COS 405",
     "title": "Blockchain Engineering",
     "department": "Computer Science",
     "level": 400,
     "semester": 2
   }
   ```
2. Commit and push — the push to `courses.json` triggers an automatic crawl.

---

## Running the Crawler Locally

```bash
# Install dependencies
npm install

# Set environment variables
export GOOGLE_SA_KEY='{"type":"service_account",...}'
export DRIVE_ROOT_FOLDER_ID='1CjXTm0EW9Z9rGG_f7nfHZva4JIHvp8We'

# Dry run (validates output, writes nothing)
npm run crawl:dry

# Live run (writes public/manifest.json)
npm run crawl
```

---

## Academics Committee — Quick Reference

| Action | Where | How often |
|---|---|---|
| Upload a new PDF | Google Drive, in the correct folder | As needed |
| Fix a badly named folder | Google Drive, rename the folder | Immediately when notified |
| Add a new course | `scripts/courses.json` in GitHub | Once per new course |
| Force a crawl refresh | GitHub Actions → Run workflow | After large upload batches |
| View flagged entries | GitHub Actions → Job Summary | After each crawl |
| View public site | Your Vercel URL | Always |

---

## Crawl Report

After each crawl, GitHub Actions posts a job summary showing:
- Total resources indexed
- Number of verified vs. flagged entries
- The exact issue for each flagged folder

Fix flagged entries by renaming the Drive folder to match the schema, then trigger a new crawl.
