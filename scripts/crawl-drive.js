/* ═══════════════════════════════════════════════════════════════════════════
   FOCITSA Knowledge Base — Google Drive Crawler

   Runs in GitHub Actions (WIF) or locally with GOOGLE_SA_KEY. NEVER runs in browser.

   Execution:
     node scripts/crawl-drive.js            # Live run (writes manifest files)
     node scripts/crawl-drive.js --dry-run  # Validation only (no file writes)

   Required environment variables:
     DRIVE_ROOT_FOLDER_ID  — The root Google Drive folder ID to crawl
     GOOGLE_SA_KEY         — JSON string of Service Account key (local dev only)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

try { require('dotenv').config(); } catch (_) { }

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { google } = require('googleapis');

// ── Constants & Registry ──────────────────────────────────────────────────────

const OFFICIAL_DEPARTMENTS = [
  'Computer Science',
  'Cyber Security',
  'Data Science',
  'Information Systems',
  'Information Technology',
  'Library and Information Science',
  'Software Engineering',
];

const DEPARTMENT_ALIASES = {
  'computer science': 'Computer Science',
  'csc': 'Computer Science',
  'cos': 'Computer Science',
  'cyber security': 'Cyber Security',
  'cybersecurity': 'Cyber Security',
  'cyb': 'Cyber Security',
  'data science': 'Data Science',
  'dsc': 'Data Science',
  'information science': 'Information Systems',
  'information systems': 'Information Systems',
  'ins': 'Information Systems',
  'information technology': 'Information Technology',
  'ift': 'Information Technology',
  'it': 'Information Technology',
  'library and information science': 'Library and Information Science',
  'library & information science': 'Library and Information Science',
  'lis': 'Library and Information Science',
  'software engineering': 'Software Engineering',
  'sen': 'Software Engineering',
  'se': 'Software Engineering',
};

const PREFIX_DEPARTMENT_MAP = {
  COS: 'Computer Science',
  CSC: 'Computer Science',
  CYB: 'Cyber Security',
  DSC: 'Data Science',
  INS: 'Information Systems',
  IS: 'Information Systems',
  IFT: 'Information Technology',
  IT: 'Information Technology',
  LIS: 'Library and Information Science',
  SEN: 'Software Engineering',
  SE: 'Software Engineering',
};

const PREFIX_ALIASES = {
  CSC: 'COS',
  COS: 'CSC',
  IFT: 'IT',
  IT: 'IFT',
  INS: 'IS',
  IS: 'INS',
  SEN: 'SE',
  SE: 'SEN',
};

const SHARED_COURSE_PREFIXES = new Set(['GST', 'MTH', 'ESI', 'STA', 'ENT', 'GNS']);
const SHARED_FOLDER_PATTERN = /^(_?shared|general|all[\s_-]*departments?|common|faculty[\s_-]*wide)$/i;
const RESOURCE_BUCKET_PATTERN = /^(past[\s_-]*q(uestion)?s?|pq|lecture[\s_-]*notes?|notes?|tutorials?|tut|syllabus|outlines?|course[\s_-]*outlines?|text[\s_-]*books?|recommended|useful[\s_-]*resources?|resources?|handouts?|slides?|assignments?|labs?)$/i;

const DANGEROUS_EXT_PATTERN = /\.(exe|bat|cmd|sh|msi|dll|scr|vbs|ps1|jar|com|app|dmg|pkg)$/i;
const JUNK_NAME_PATTERN = /^(\.DS_Store|Thumbs\.db|desktop\.ini|~\$.*|\._.*)$/i;
const DANGEROUS_MIME_TYPES = new Set([
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-executable',
  'application/x-sh',
  'application/x-bat',
  'application/x-csh',
  'application/x-msi',
]);

const SAFE_DRIVE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const COURSE_CODE_STRICT_FOLDER = /^([A-Za-z]{2,4})[\s_-]?(\d{3})(?=[^0-9A-Za-z]|$)/;
const COURSE_CODE_EXTRACT = /(?:^|[^A-Za-z0-9])([A-Za-z]{2,4})[\s_-]?(\d{3})(?=[^0-9A-Za-z]|$)/i;

const TYPE_PATTERNS = [
  { pattern: /past[\s_-]?q(uestion)?s?|(?:^|[^A-Za-z0-9])pq(?=[^A-Za-z0-9]|$)/i, type: 'Past Question' },
  { pattern: /note|lecture|slide|handout/i, type: 'Lecture Notes' },
  { pattern: /tutorial|(?:^|[^A-Za-z0-9])tut(?=[^A-Za-z0-9]|$)/i, type: 'Tutorial' },
  { pattern: /syllabus|outline|course.?plan/i, type: 'Syllabus' },
  { pattern: /text.*book|textbook|recommended/i, type: 'Textbook' },
];

const MIME_EXT_MAP = {
  'application/pdf': 'PDF',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/msword': 'DOC',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.ms-excel': 'XLS',
  'application/zip': 'ZIP',
  'application/x-zip-compressed': 'ZIP',
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/csv': 'CSV',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
};

const COURSE_REGISTRY = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'courses.json'), 'utf-8')
);

// ── Field Extractors & Normalizers ────────────────────────────────────────────

/**
 * Normalise a Drive top-level folder name into one of the 7 official departments.
 * Returns null if the folder represents a shared bucket (_Shared, General, etc.).
 * @param {string} folderName
 * @returns {{ department: string, isSharedFolder: boolean }}
 */
function resolveDepartmentFolder(folderName) {
  const cleaned = String(folderName || '').trim();
  if (!cleaned) {
    return { department: 'General', isSharedFolder: true };
  }
  if (SHARED_FOLDER_PATTERN.test(cleaned)) {
    return { department: 'All Departments', isSharedFolder: true };
  }
  const key = cleaned.toLowerCase().replace(/\s+/g, ' ');
  if (DEPARTMENT_ALIASES[key]) {
    return { department: DEPARTMENT_ALIASES[key], isSharedFolder: false };
  }
  const exactOfficial = OFFICIAL_DEPARTMENTS.find(d => d.toLowerCase() === key);
  return {
    department: exactOfficial || cleaned,
    isSharedFolder: false,
  };
}

/**
 * Extract a normalised course code (e.g. "CSC202") from a folder or file name.
 * @param {string} text
 * @returns {string|null}
 */
function extractCourseCode(text) {
  if (!text) return null;
  const match = String(text).match(COURSE_CODE_EXTRACT);
  if (!match) return null;
  return `${match[1].toUpperCase()}${match[2]}`;
}

/**
 * Format compact course code ("CSC202") into display form ("CSC 202").
 * @param {string} compactCode
 * @returns {string}
 */
function formatCourseCode(compactCode) {
  if (!compactCode) return 'GENERAL';
  const match = compactCode.match(/^([A-Z]{2,4})(\d{3})$/i);
  return match ? `${match[1].toUpperCase()} ${match[2]}` : compactCode.toUpperCase();
}

/**
 * Look up course metadata in courses.json directly or via prefix aliases (CSC <-> COS).
 * @param {string|null} rawCode
 * @returns {object|null}
 */
function lookupRegistry(rawCode) {
  if (!rawCode) return null;
  if (COURSE_REGISTRY[rawCode]) return COURSE_REGISTRY[rawCode];

  const match = rawCode.match(/^([A-Z]{2,4})(\d{3})$/);
  if (!match) return null;

  const altPrefix = PREFIX_ALIASES[match[1]];
  if (altPrefix && COURSE_REGISTRY[`${altPrefix}${match[2]}`]) {
    return COURSE_REGISTRY[`${altPrefix}${match[2]}`];
  }
  return null;
}

/**
 * Build search aliases (e.g. ["CSC 202", "CSC202", "COS 202", "COS202"]) for a course code.
 * @param {string|null} rawCode
 * @param {object|null} registry
 * @returns {string[]}
 */
function buildCourseAliases(rawCode, registry) {
  const aliases = new Set();

  if (rawCode) {
    aliases.add(rawCode.toUpperCase());
    aliases.add(formatCourseCode(rawCode));

    const m = rawCode.match(/^([A-Z]{2,4})(\d{3})$/);
    if (m && PREFIX_ALIASES[m[1]]) {
      const alt = `${PREFIX_ALIASES[m[1]]}${m[2]}`;
      aliases.add(alt);
      aliases.add(formatCourseCode(alt));
    }
  }

  if (registry?.aliases && Array.isArray(registry.aliases)) {
    for (const alias of registry.aliases) {
      const upper = String(alias).toUpperCase().trim();
      if (upper) {
        aliases.add(upper);
        aliases.add(upper.replace(/\s+/g, ''));
      }
    }
  }

  return [...aliases];
}

/**
 * Extract academic level (100..400) from a path segment or course code.
 * @param {string} segment
 * @returns {number|null}
 */
function parseLevel(segment) {
  if (!segment) return null;
  const m =
    segment.match(/(?:^|[^0-9])(\d{3})\s*[-_]?\s*(?:level|l(?=$|[^A-Za-z0-9]))/i) ||
    segment.match(/(?:^|[^A-Za-z0-9])(?:level|l)\s*[-_]?\s*(\d{3})(?=$|[^0-9])/i) ||
    segment.match(/^(\d{3})$/);
  if (!m) return null;
  const level = parseInt(m[1], 10);
  return level >= 100 && level <= 600 ? level : null;
}

/**
 * Extract semester (1 or 2) from a path segment.
 * @param {string} segment
 * @returns {number|null}
 */
function parseSemester(segment) {
  if (!segment) return null;
  if (/(?:^|[^A-Za-z0-9])(first|1st|sem(?:ester)?[-_\s]?1|1[-_\s]?sem(?:ester)?)(?=[^A-Za-z0-9]|$)/i.test(segment)) return 1;
  if (/(?:^|[^A-Za-z0-9])(second|2nd|sem(?:ester)?[-_\s]?2|2[-_\s]?sem(?:ester)?)(?=[^A-Za-z0-9]|$)/i.test(segment)) return 2;
  return null;
}

/**
 * Extract resource type from a segment or filename.
 * @param {string} segment
 * @returns {string}
 */
function parseType(segment) {
  if (!segment) return 'Resource';
  for (const { pattern, type } of TYPE_PATTERNS) {
    if (pattern.test(segment)) return type;
  }
  return 'Resource';
}

/**
 * Extract a valid academic year (2018 .. currentYear + 1) from a string.
 * Ignores older publication years (e.g. 2007 textbooks).
 * @param {string} str
 * @returns {number|null}
 */
function parseYear(str) {
  if (!str) return null;
  const minYear = 2018;
  const maxYear = new Date().getFullYear() + 1;
  const regex = /(?:^|[^0-9])(20\d{2})(?=[^0-9]|$)/g;
  for (const match of String(str).matchAll(regex)) {
    const year = parseInt(match[1], 10);
    if (year >= minYear && year <= maxYear) {
      return year;
    }
  }
  return null;
}

/**
 * Clean a file or folder name into a readable fallback title.
 * @param {string} name
 * @returns {string}
 */
function cleanReadableTitle(name) {
  return String(name || '')
    .replace(/\.[^/.]+$/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Check whether a Drive item should be skipped for security or OS-junk hygiene.
 * @param {{ name: string, mimeType: string }} file
 * @returns {boolean}
 */
function shouldSkipFile(file) {
  if (!file || !file.name) return true;
  if (JUNK_NAME_PATTERN.test(file.name)) return true;
  if (DANGEROUS_EXT_PATTERN.test(file.name)) return true;
  if (DANGEROUS_MIME_TYPES.has(file.mimeType)) return true;
  return false;
}

/**
 * Derive MIME routing URLs and normalized fileExt for Drive & Google Workspace items.
 * @param {string} fileId
 * @param {string} fileName
 * @param {string} mimeType
 * @returns {{ fileExt: string, previewUrl: string, downloadUrl: string, driveViewUrl: string }}
 */
function buildFileAccessMetadata(fileId, fileName, mimeType) {
  if (mimeType === 'application/vnd.google-apps.document') {
    return {
      fileExt: 'GDOC',
      previewUrl: `https://docs.google.com/document/d/${fileId}/preview`,
      downloadUrl: `https://docs.google.com/document/d/${fileId}/export?format=pdf`,
      driveViewUrl: `https://docs.google.com/document/d/${fileId}/view`,
    };
  }
  if (mimeType === 'application/vnd.google-apps.presentation') {
    return {
      fileExt: 'GSLIDES',
      previewUrl: `https://docs.google.com/presentation/d/${fileId}/preview`,
      downloadUrl: `https://docs.google.com/presentation/d/${fileId}/export/pdf`,
      driveViewUrl: `https://docs.google.com/presentation/d/${fileId}/view`,
    };
  }
  if (mimeType === 'application/vnd.google-apps.spreadsheet') {
    return {
      fileExt: 'GSHEET',
      previewUrl: `https://docs.google.com/spreadsheets/d/${fileId}/preview`,
      downloadUrl: `https://docs.google.com/spreadsheets/d/${fileId}/export?format=xlsx`,
      driveViewUrl: `https://docs.google.com/spreadsheets/d/${fileId}/view`,
    };
  }

  const extMatch = String(fileName || '').match(/\.([A-Za-z0-9]{1,8})$/);
  const extFromName = extMatch ? extMatch[1].toUpperCase() : null;
  const fileExt = extFromName || MIME_EXT_MAP[mimeType] || 'FILE';

  return {
    fileExt,
    previewUrl: `https://drive.google.com/file/d/${fileId}/preview`,
    downloadUrl: `https://drive.google.com/uc?export=download&id=${fileId}`,
    driveViewUrl: `https://drive.google.com/file/d/${fileId}/view`,
  };
}

/**
 * Determine whether a Drive file is publicly readable ("Anyone with the link").
 * @param {object} file
 * @returns {boolean}
 */
function checkPublicReadable(file) {
  const hasAnyonePerm =
    Array.isArray(file.permissions) &&
    file.permissions.some((p) => p.type === 'anyone');
  return hasAnyonePerm || file.shared !== false;
}

/**
 * Build searchable tag list from resolved metadata.
 */
function buildTags({ registry, rawCode, aliases, year, type, department, fileExt }) {
  const tags = new Set();

  if (registry) {
    registry.title.toLowerCase().split(/\s+/).forEach(w => {
      if (w.length > 2) tags.add(w);
    });
  }
  if (rawCode) tags.add(rawCode.toLowerCase());
  for (const alias of aliases) {
    tags.add(alias.toLowerCase());
  }
  if (department) tags.add(department.toLowerCase());
  if (year) tags.add(String(year));
  if (type) tags.add(type.toLowerCase());
  if (fileExt) tags.add(fileExt.toLowerCase());

  return [...tags];
}

// ── Manifest Entry Builder ────────────────────────────────────────────────────

/**
 * Construct a manifest entry from a Drive file and its pathSegments.
 * Expects depth-0 preserved:
 *   [0] Department (or _Shared)
 *   [1..] Level / Semester / Course or Resource Bucket
 *
 * @param {{ id: string, name: string, mimeType: string, modifiedTime: string, shared?: boolean, permissions?: Array }} file
 * @param {string[]} pathSegments
 * @returns {object}
 */
function buildManifestEntry(file, pathSegments) {
  const issues = [];
  const fileId = file.effectiveId || file.id;
  const mimeType = file.effectiveMimeType || file.mimeType || 'application/octet-stream';

  if (!SAFE_DRIVE_ID_PATTERN.test(fileId)) {
    issues.push(`Unsafe or invalid Drive file ID: "${fileId}"`);
  }

  const isPublic = checkPublicReadable(file);
  if (!isPublic) {
    issues.push('File is not publicly shared (Anyone with the link)');
  }

  // [0] Top-level department or _Shared folder
  const topSeg = pathSegments[0] ?? '';
  const { department, isSharedFolder } = resolveDepartmentFolder(topSeg);
  const restSegments = pathSegments.slice(1);

  let level = null;
  let semester = null;
  let courseSeg = '';
  let bucketSeg = '';
  let typeSeg = '';

  for (const seg of restSegments) {
    const parsedLevel = parseLevel(seg);
    if (!level && parsedLevel) {
      level = parsedLevel;
      continue;
    }

    const parsedSem = parseSemester(seg);
    if (!semester && parsedSem) {
      semester = parsedSem;
      continue;
    }

    if (RESOURCE_BUCKET_PATTERN.test(seg.trim())) {
      bucketSeg = seg;
      if (!typeSeg) typeSeg = seg;
      continue;
    }

    if (!courseSeg && COURSE_CODE_STRICT_FOLDER.test(seg.trim())) {
      courseSeg = seg;
      continue;
    }

    if (!courseSeg && extractCourseCode(seg)) {
      courseSeg = seg;
      continue;
    }

    // Sub-folder inside a course or bucket
    if (!typeSeg && parseType(seg) !== 'Resource') {
      typeSeg = seg;
    } else if (!bucketSeg) {
      bucketSeg = seg;
    }
  }

  // Extract course code: prefer course folder, fall back to filename
  const rawCode = extractCourseCode(courseSeg) || extractCourseCode(file.name);
  const registry = lookupRegistry(rawCode);
  const aliases = buildCourseAliases(rawCode, registry);

  // Enrich level and semester from registry or course code digit if absent from folders
  if (!level) {
    level = registry?.level ?? null;
    if (!level && rawCode) {
      const levelDigit = rawCode.match(/(\d)\d{2}$/);
      if (levelDigit) {
        const inferred = parseInt(levelDigit[1], 10) * 100;
        if (inferred >= 100 && inferred <= 600) level = inferred;
      }
    }
  }
  if (!semester) {
    semester = registry?.semester ?? null;
  }

  // Determine type (check explicit type folder, then bucket folder, then filename)
  let type = parseType(typeSeg);
  if (type === 'Resource' && bucketSeg) type = parseType(bucketSeg);
  if (type === 'Resource') type = parseType(file.name);

  const year = parseYear(file.name) ?? parseYear(typeSeg) ?? parseYear(bucketSeg);
  const prefix = rawCode ? rawCode.replace(/\d+$/, '') : '';
  const isSharedCourse =
    isSharedFolder ||
    Boolean(registry?.shared) ||
    SHARED_COURSE_PREFIXES.has(prefix);

  // Course code & title resolution (registry enriches, never gates)
  const courseCode = registry?.code ?? (rawCode ? formatCourseCode(rawCode) : 'GENERAL');
  let courseTitle = registry?.title;
  if (!courseTitle) {
    if (courseSeg && !RESOURCE_BUCKET_PATTERN.test(courseSeg.trim())) {
      const stripped = courseSeg
        .replace(COURSE_CODE_STRICT_FOLDER, '')
        .replace(/^[-_\s]+/, '');
      courseTitle = cleanReadableTitle(stripped) || cleanReadableTitle(file.name) || courseCode;
    } else {
      courseTitle = cleanReadableTitle(file.name) || cleanReadableTitle(bucketSeg) || courseCode;
    }
  }

  // Department attribution
  const resolvedDept = isSharedFolder
    ? 'All Departments'
    : (department || PREFIX_DEPARTMENT_MAP[prefix] || 'General');
  const departments = isSharedCourse ? ['ALL'] : [resolvedDept];

  const access = buildFileAccessMetadata(fileId, file.name, mimeType);
  const verified = issues.length === 0;

  return {
    id: `${(rawCode ?? 'general').toLowerCase()}-${type.replace(/\s+/g, '-').toLowerCase()}-${year ?? 'undated'}-${fileId.slice(-6)}`,
    courseCode,
    aliases,
    courseTitle,
    fileName: file.name,
    department: resolvedDept,
    departments,
    level,
    semester,
    type,
    year: year ?? null,
    fileId,
    fileSize: file.size ? Number(file.size) : null,
    mimeType,
    fileExt: access.fileExt,
    previewUrl: access.previewUrl,
    downloadUrl: access.downloadUrl,
    driveViewUrl: access.driveViewUrl,
    isPublic,
    tags: buildTags({
      registry,
      rawCode,
      aliases,
      year,
      type,
      department: resolvedDept,
      fileExt: access.fileExt,
    }),
    verified,
    uploadedAt: file.modifiedTime,
    ...(issues.length > 0 && { issues }),
  };
}

// ── Google Drive Traversal ────────────────────────────────────────────────────

/**
 * Recursively list all safe files under a Drive folder with pagination & Shared Drive support.
 * Preserves depth === 0 (department / _Shared) in pathSegments.
 *
 * @param {object} drive
 * @param {string} folderId
 * @param {string[]} pathSegments
 * @param {number} depth
 * @param {Set<string>} visitedFolders
 * @returns {Promise<object[]>}
 */
async function crawlFolder(drive, folderId, pathSegments = [], depth = 0, visitedFolders = new Set()) {
  if (!SAFE_DRIVE_ID_PATTERN.test(folderId)) {
    console.warn(`  ⚠  Skipping invalid folder ID: ${folderId}`);
    return [];
  }
  if (depth > 8) {
    console.warn(`  ⚠  Max depth reached at: ${pathSegments.join(' / ')}`);
    return [];
  }
  if (visitedFolders.has(folderId)) {
    return [];
  }
  visitedFolders.add(folderId);

  const files = [];
  let pageToken;

  try {
    do {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, shared, permissions(type, role), shortcutDetails(targetId, targetMimeType))',
        pageSize: 1000,
        pageToken,
        orderBy: 'folder,name',
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      if (Array.isArray(res.data.files)) {
        files.push(...res.data.files);
      }
      pageToken = res.data.nextPageToken;
    } while (pageToken);
  } catch (err) {
    console.error(`  ✖  Failed to list folder "${pathSegments.join(' / ') || 'ROOT'}": ${err.message}`);
    return [];
  }

  const entries = [];

  for (const file of files) {
    const isShortcut = file.mimeType === 'application/vnd.google-apps.shortcut';
    const effectiveMimeType = isShortcut ? file.shortcutDetails?.targetMimeType : file.mimeType;
    const effectiveId = isShortcut ? file.shortcutDetails?.targetId : file.id;

    if (!effectiveId || !SAFE_DRIVE_ID_PATTERN.test(effectiveId)) {
      continue;
    }

    if (effectiveMimeType === 'application/vnd.google-apps.folder') {
      // Preserve depth === 0 (Department / _Shared)
      const childPath = [...pathSegments, file.name];
      const children = await crawlFolder(drive, effectiveId, childPath, depth + 1, visitedFolders);
      entries.push(...children);
      continue;
    }

    const item = {
      ...file,
      effectiveId,
      effectiveMimeType: effectiveMimeType || file.mimeType,
    };

    if (shouldSkipFile({ name: item.name, mimeType: item.effectiveMimeType })) {
      console.log(`  ⏭  Skipped unsafe/junk file: ${item.name}`);
      continue;
    }

    const entry = buildManifestEntry(item, pathSegments);
    entries.push(entry);

    const status = entry.verified ? '✔' : '⚠';
    console.log(`  ${status}  [${entry.department}] ${entry.courseCode} — ${entry.fileName} (${entry.fileExt})`);
    if (!entry.verified) {
      entry.issues.forEach(i => console.log(`       → ${i}`));
    }
  }

  return entries;
}

/**
 * Deduplicate crawled manifest entries across shortcuts (same fileId) and
 * duplicate faculty-wide shared uploads (same courseCode + fileName + size).
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function deduplicateEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];

  // Pass 1: Collapse same fileId (e.g. Drive shortcuts across department folders)
  const byFileId = new Map();
  for (const entry of entries) {
    const existing = byFileId.get(entry.fileId);
    if (!existing) {
      byFileId.set(entry.fileId, {
        ...entry,
        departments: [...(entry.departments || [])],
        aliases: [...(entry.aliases || [])],
        tags: [...(entry.tags || [])],
      });
      continue;
    }

    const mergedDepts = (existing.departments.includes('ALL') || (entry.departments || []).includes('ALL'))
      ? ['ALL']
      : [...new Set([...existing.departments, ...(entry.departments || [])])];

    const preferIncoming = entry.department === 'All Departments' && existing.department !== 'All Departments';
    const primary = preferIncoming ? entry : existing;

    byFileId.set(entry.fileId, {
      ...primary,
      department: mergedDepts.includes('ALL')
        ? 'All Departments'
        : (mergedDepts.length > 1 ? mergedDepts.join(', ') : (primary.department || mergedDepts[0])),
      departments: mergedDepts,
      aliases: [...new Set([...existing.aliases, ...(entry.aliases || [])])],
      tags: [...new Set([...existing.tags, ...(entry.tags || [])])],
      verified: existing.verified && entry.verified,
    });
  }

  // Pass 2: Collapse duplicate faculty-wide uploads (same courseCode + fileName + size)
  const bySharedSignature = new Map();
  const deduped = [];

  for (const entry of byFileId.values()) {
    const isShared = Array.isArray(entry.departments) && entry.departments.includes('ALL');
    if (!isShared) {
      deduped.push(entry);
      continue;
    }

    const sig = `${String(entry.courseCode || '').toUpperCase()}|${String(entry.fileName || '').toLowerCase().trim()}|${entry.fileSize ?? ''}`;
    const existingIdx = bySharedSignature.get(sig);
    if (existingIdx === undefined) {
      bySharedSignature.set(sig, deduped.length);
      deduped.push(entry);
      continue;
    }

    const current = deduped[existingIdx];
    const entryIsCanonicalShared = entry.department === 'All Departments' && current.department !== 'All Departments';
    const currentIsCanonicalShared = current.department === 'All Departments' && entry.department !== 'All Departments';

    if (entryIsCanonicalShared) {
      deduped[existingIdx] = entry;
    } else if (!currentIsCanonicalShared) {
      const entryTime = Date.parse(entry.uploadedAt || '') || 0;
      const currentTime = Date.parse(current.uploadedAt || '') || 0;
      if ((entry.verified && !current.verified) || (entry.verified === current.verified && entryTime > currentTime)) {
        deduped[existingIdx] = entry;
      }
    }
  }

  return deduped;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');

  if (DRY_RUN) {
    console.log('🔍 Running in DRY-RUN mode — no files will be written.\n');
  }

  if (!process.env.DRIVE_ROOT_FOLDER_ID) {
    console.error('❌ Missing required environment variable: DRIVE_ROOT_FOLDER_ID');
    process.exit(1);
  }

  const DRIVE_ROOT_FOLDER_ID = process.env.DRIVE_ROOT_FOLDER_ID;
  const IS_LOCAL = Boolean(process.env.GOOGLE_SA_KEY);

  console.log('🚀 FOCITSA Knowledge Base — Drive Crawler\n');
  console.log(`📂 Root folder: ${DRIVE_ROOT_FOLDER_ID}`);
  console.log(`📅 Started: ${new Date().toISOString()}\n`);

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

  console.log('🔎 Crawling folder tree…\n');
  const rawEntries = await crawlFolder(drive, DRIVE_ROOT_FOLDER_ID);
  const allEntries = deduplicateEntries(rawEntries);
  if (rawEntries.length !== allEntries.length) {
    console.log(`\n🧹 Deduplicated ${rawEntries.length - allEntries.length} duplicate/shortcut entries.`);
  }

  if (allEntries.length === 0) {
    console.warn('\n⚠  No resources found. Check the folder ID and sharing permissions.');
    process.exit(0);
  }

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
    console.log('⚠  Flagged entries (review permissions or Drive naming):');
    flagged.forEach(e => {
      console.log(`\n  📁 ${e.courseCode} — ${e.fileName}`);
      e.issues?.forEach(i => console.log(`     → ${i}`));
    });
    console.log('');
  }

  const manifestJson = JSON.stringify(allEntries, null, 2);
  const versionJson = JSON.stringify({
    hash,
    count: allEntries.length,
    generatedAt: new Date().toISOString(),
  }, null, 2);
  const crawlReportJson = JSON.stringify({
    generatedAt: new Date().toISOString(),
    totalEntries: allEntries.length,
    verifiedCount: verified.length,
    flaggedCount: flagged.length,
    flagged,
  }, null, 2);

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
  console.log(`   public/crawl-report.json     (${flagged.length} flagged entries)`);

  process.exit(0);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('\n❌ Crawler crashed unexpectedly:', err);
    process.exit(1);
  });
}

module.exports = {
  OFFICIAL_DEPARTMENTS,
  resolveDepartmentFolder,
  extractCourseCode,
  formatCourseCode,
  lookupRegistry,
  buildCourseAliases,
  parseLevel,
  parseSemester,
  parseType,
  parseYear,
  shouldSkipFile,
  buildFileAccessMetadata,
  checkPublicReadable,
  buildManifestEntry,
  deduplicateEntries,
};
