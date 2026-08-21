/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Google Drive Crawler
   
   Runs exclusively in GitHub Actions. NEVER runs in the browser.
   
   Execution:
     node scripts/crawl-drive.js            # Live run (writes manifest files)
     node scripts/crawl-drive.js --dry-run  # Validation only (no file writes)
   
   Required environment variables:
     GOOGLE_SA_KEY         — JSON string of the Google Service Account key
     DRIVE_ROOT_FOLDER_ID  — The root Google Drive folder ID to crawl
   
   Output:
     public/manifest.json         — Full searchable index (verified + unverified)
     public/manifest.version.json — SHA-256 content hash sidecar
     public/crawl-report.json     — Only flagged entries (for committee review)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

// Load .env for local development. In GitHub Actions, secrets are injected
// directly into process.env — dotenv is a no-op when the file is absent.
try { require('dotenv').config(); } catch (_) { }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

// ── CLI Flags ─────────────────────────────────────────────────────────────────

const DRY_RUN = process.argv.includes('--dry-run');

if (DRY_RUN) {
  console.log('🔍 Running in DRY-RUN mode — no files will be written.\n');
}

// ── Environment Validation ────────────────────────────────────────────────────

// DRIVE_ROOT_FOLDER_ID is always required.
// GOOGLE_SA_KEY is only required for local development.
// In GitHub Actions, WIF sets GOOGLE_APPLICATION_CREDENTIALS automatically.
if (!process.env.DRIVE_ROOT_FOLDER_ID) {
  console.error('❌ Missing required environment variable: DRIVE_ROOT_FOLDER_ID');
  process.exit(1);
}

const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;
const IS_LOCAL = !!process.env.GOOGLE_SA_KEY;

// ── Course Registry ───────────────────────────────────────────────────────────

/** @type {Record<string, {code:string, title:string, department:string, level:number, semester:number}>} */
const COURSE_REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'courses.json'), 'utf-8')
);

// ── Resource Type Detection ────────────────────────────────────────────────────

const TYPE_PATTERNS = [
  { pattern: /past[\s_\-]?q(uestion)?s?/i, type: 'Past Question' },
  { pattern: /pq/i, type: 'Past Question' },
  { pattern: /note|lecture/i, type: 'Lecture Notes' },
  { pattern: /tutorial|tut/i, type: 'Tutorial' },
  { pattern: /syllabus|outline|course.?plan/i, type: 'Syllabus' },
  { pattern: /text.*book|textbook|recommended/i, type: 'Textbook' },
];

// ── Fault-Tolerant Field Extractors ──────────────────────────────────────────

/**
 * Extract a normalised course code (e.g. "COS201") from a folder name.
 * Handles: "COS_201_Discrete_Structures", "COS 201-Discrete", "cos201_discrete"
 * @param {string} folderName
 * @returns {string|null}
 */
function extractCourseCode(folderName) {
  const match = folderName.match(/([A-Za-z]{2,4})\s*[-_\s]?\s*(\d{3})/i);
  if (!match) return null;
  return `${match[1].toUpperCase()}${match[2]}`; // → "COS201"
}

/**
 * Extract the academic level (100, 200, 300, 400) from a path segment.
 * Handles: "200_LEVEL", "200L", "200-Level", "200_level", "LEVEL_200"
 * @param {string} segment
 * @returns {number|null}
 */
function parseLevel(segment) {
  const m =
    segment.match(/(\d{3})\s*[-_]?\s*(?:level|l\b)/i) ||
    segment.match(/(?:level|l)\s*[-_]?\s*(\d{3})/i) ||
    segment.match(/^(\d{3})$/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Extract the semester (1 or 2) from a path segment.
 * Handles: "FIRST_SEMESTER", "1st_Sem", "SEM_1", "Semester-2", "second"
 * @param {string} segment
 * @returns {number|null}
 */
function parseSemester(segment) {
  if (/\b(first|1st|sem(?:ester)?[-_\s]?1|1[-_\s]?sem(?:ester)?)\b/i.test(segment)) return 1;
  if (/\b(second|2nd|sem(?:ester)?[-_\s]?2|2[-_\s]?sem(?:ester)?)\b/i.test(segment)) return 2;
  return null;
}

/**
 * Extract the resource type from a path segment.
 * Falls back to 'Resource' — NEVER returns null.
 * @param {string} segment
 * @returns {string}
 */
function parseType(segment) {
  for (const { pattern, type } of TYPE_PATTERNS) {
    if (pattern.test(segment)) return type;
  }
  return 'Resource';
}

/**
 * Extract the most recent 4-digit year (20xx) found in a string.
 * @param {string} str
 * @returns {number|null}
 */
function parseYear(str) {
  const match = str.match(/\b(20\d{2})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Build a list of searchable tags from course registry entry and file metadata.
 * @param {object|null} registry
 * @param {string|null} rawCode
 * @param {number|null} year
 * @param {string} type
 * @returns {string[]}
 */
function buildTags(registry, rawCode, year, type) {
  const tags = new Set();

  if (registry) {
    tags.add(registry.code.toLowerCase().replace(/\s/g, ''));
    registry.title.toLowerCase().split(/\s+/).forEach(w => w.length > 2 && tags.add(w));
    tags.add(registry.department.toLowerCase());
  }
  if (rawCode) tags.add(rawCode.toLowerCase());
  if (year) tags.add(String(year));
  if (type) tags.add(type.toLowerCase());

  return [...tags];
}

// ── Manifest Entry Builder ────────────────────────────────────────────────────

/**
 * Construct a manifest entry from a Drive file and its folder path.
 * Returns a partial entry with verified=false and an issues array if
 * metadata cannot be fully resolved — never throws.
 *
 * @param {{ id: string, name: string, modifiedTime: string }} file
 * @param {string[]} pathSegments — folder names from root to immediate parent
 * @returns {object} manifest entry
 */
function buildManifestEntry(file, pathSegments) {
  const issues = [];

  // Path layout expected:
  //  [0] FOCITSA_KNOWLEDGE_BASE  (root — already stripped)
  //  [1] 200_LEVEL
  //  [2] FIRST_SEMESTER
  //  [3] COS_201_Discrete_Structures
  //  [4] Past_Questions  (optional — some files sit directly in course folder)

  const levelSeg = pathSegments[0] ?? '';
  const semSeg = pathSegments[1] ?? '';
  const courseSeg = pathSegments[2] ?? '';
  const typeSeg = pathSegments[3] ?? file.name; // fallback to filename

  // Course code extraction + registry lookup
  const rawCode = extractCourseCode(courseSeg);
  const registry = rawCode ? COURSE_REGISTRY[rawCode] : null;

  if (!rawCode) issues.push(`Could not extract course code from folder: "${courseSeg}"`);
  if (!registry) issues.push(`Course code "${rawCode}" not found in courses.json — add it to scripts/courses.json`);

  // Field extraction (independent — each fails safely)
  const level = parseLevel(levelSeg) ?? registry?.level ?? null;
  const semester = parseSemester(semSeg) ?? registry?.semester ?? null;
  const type = parseType(typeSeg);
  const year = parseYear(file.name) ?? parseYear(typeSeg);

  if (!level) issues.push(`Could not parse level from: "${levelSeg}"`);
  if (!semester) issues.push(`Could not parse semester from: "${semSeg}"`);

  const verified = issues.length === 0;

  return {
    id: `${(rawCode ?? 'unknown').toLowerCase()}-${type.replace(/\s/g, '-').toLowerCase()}-${year ?? 'undated'}-${file.id.slice(-6)}`,
    courseCode: registry?.code ?? (rawCode ? `${rawCode.slice(0, -3)} ${rawCode.slice(-3)}` : 'UNKNOWN'),
    courseTitle: registry?.title ?? courseSeg.replace(/[-_]/g, ' ').trim(),
    department: registry?.department ?? 'Unverified',
    level,
    semester,
    type,
    year: year ?? null,
    fileId: file.id,
    tags: buildTags(registry, rawCode, year, type),
    verified,
    uploadedAt: file.modifiedTime,
    ...(issues.length > 0 && { issues }),
  };
}

// ── Google Drive Traversal ────────────────────────────────────────────────────

/**
 * Recursively list all PDF files under a Drive folder.
 *
 * @param {object} drive — google.drive('v3') client
 * @param {string} folderId
 * @param {string[]} pathSegments — accumulated path from root (excluding root folder)
 * @param {number} depth — current recursion depth (guard against infinite loops)
 * @returns {Promise<object[]>} flat array of manifest entries
 */
async function crawlFolder(drive, folderId, pathSegments = [], depth = 0) {
  if (depth > 6) {
    console.warn(`  ⚠  Max depth reached at: ${pathSegments.join(' / ')}`);
    return [];
  }

  let files;
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      fields: 'files(id, name, mimeType, modifiedTime)',
      pageSize: 1000,
      orderBy: 'name',
    });
    files = res.data.files ?? [];
  } catch (err) {
    console.error(`  ✖  Failed to list folder "${pathSegments.join(' / ')}": ${err.message}`);
    return [];
  }

  const entries = [];

  for (const file of files) {
    if (file.mimeType === 'application/vnd.google-apps.folder') {
      // Recurse — strip the root folder name from path segments
      const childPath = depth === 0 ? [] : [...pathSegments, file.name];
      const children = await crawlFolder(drive, file.id, childPath, depth + 1);
      entries.push(...children);

    } else if (file.mimeType === 'application/pdf') {
      const entry = buildManifestEntry(file, pathSegments);
      entries.push(entry);

      const status = entry.verified ? '✔' : '⚠';
      console.log(`  ${status}  ${entry.courseCode} — ${entry.type} (${entry.year ?? '?'})`);
      if (!entry.verified) {
        entry.issues.forEach(i => console.log(`       → ${i}`));
      }
    }
    // Skip non-PDF, non-folder items silently
  }

  return entries;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('🚀 FOCITSA Knowledge Base — Drive Crawler\n');
  console.log(`📂 Root folder: ${DRIVE_ROOT_FOLDER_ID}`);
  console.log(`📅 Started: ${new Date().toISOString()}\n`);

  // ── Authenticate with Google Drive API ──────────────────────────────────────
  // ── Authenticate with Google Drive API ──────────────────────────────────────
  // Strategy 1 (local dev): GOOGLE_SA_KEY in .env → explicit service account
  // Strategy 2 (GitHub Actions + WIF): GOOGLE_APPLICATION_CREDENTIALS is set
  //   automatically by google-github-actions/auth@v2 → googleapis uses ADC
  let auth;
  try {
    if (IS_LOCAL) {
      const saKey = JSON.parse(process.env.GOOGLE_SA_KEY);
      auth = new google.auth.GoogleAuth({
        credentials: saKey,
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      console.log('🔑 Auth: Service Account key (local dev)');
    } else {
      // Application Default Credentials — set by WIF action in CI
      auth = new google.auth.GoogleAuth({
        scopes: ['https://www.googleapis.com/auth/drive.readonly'],
      });
      console.log('🔒 Auth: Workload Identity Federation (keyless)');
    }
  } catch (err) {
    console.error('❌ Authentication setup failed:', err.message);
    process.exit(1);
  }


  const drive = google.drive({ version: 'v3', auth });

  // ── Crawl ────────────────────────────────────────────────────────────────────
  console.log('🔎 Crawling folder tree…\n');
  const allEntries = await crawlFolder(drive, DRIVE_ROOT_FOLDER_ID);

  if (allEntries.length === 0) {
    console.warn('\n⚠  No PDF files found. Check the folder ID and sharing permissions.');
    process.exit(0);
  }

  // ── Summary ───────────────────────────────────────────────────────────────────
  const verified = allEntries.filter(e => e.verified);
  const flagged = allEntries.filter(e => !e.verified);
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify(allEntries))
    .digest('hex')
    .slice(0, 12);

  console.log('\n──────────────────────────────────────────');
  console.log(`  Total entries  : ${allEntries.length}`);
  console.log(`  ✔ Verified     : ${verified.length}`);
  console.log(`  ⚠ Flagged      : ${flagged.length}`);
  console.log(`  Content hash   : ${hash}`);
  console.log('──────────────────────────────────────────\n');

  if (flagged.length > 0) {
    console.log('⚠  Flagged entries (fix folder names or update courses.json):');
    flagged.forEach(e => {
      console.log(`\n  📁 ${e.courseCode} — ${e.type}`);
      e.issues?.forEach(i => console.log(`     → ${i}`));
    });
    console.log('');
  }

  // ── Write output files ───────────────────────────────────────────────────────
  const manifestJson = JSON.stringify(allEntries, null, 2);
  const versionJson = JSON.stringify({ hash, count: allEntries.length, generatedAt: new Date().toISOString() }, null, 2);
  const crawlReportJson = JSON.stringify({ generatedAt: new Date().toISOString(), totalEntries: allEntries.length, verifiedCount: verified.length, flaggedCount: flagged.length, flagged }, null, 2);

  if (DRY_RUN) {
    console.log('✅ Dry run complete — no files written.');
    console.log('   manifest.json preview (first entry):\n');
    console.log(JSON.stringify(allEntries[0], null, 2));
    process.exit(0);
  }

  const outDir = path.join(__dirname, '..', 'public');

  fs.writeFileSync(path.join(outDir, 'manifest.json'), manifestJson, 'utf-8');
  fs.writeFileSync(path.join(outDir, 'manifest.version.json'), versionJson, 'utf-8');
  fs.writeFileSync(path.join(outDir, 'crawl-report.json'), crawlReportJson, 'utf-8');

  console.log('✅ Files written:');
  console.log(`   public/manifest.json         (${allEntries.length} entries)`);
  console.log(`   public/manifest.version.json (hash: ${hash})`);
  if (flagged.length > 0) {
    console.log(`   public/crawl-report.json     (${flagged.length} flagged entries)`);
  }

  // Exit with 0 even when there are flagged entries — the pipeline MUST NOT fail
  // due to naming inconsistencies. Flagged entries are a warning, not a crash.
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Crawler crashed unexpectedly:', err);
  process.exit(1);
});
