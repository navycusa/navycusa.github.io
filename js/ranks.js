// ============================================================
// US NAVY CUSA PORTAL — Rank & Division Definitions
// ============================================================

const RANKS = [
  // ── HQ ──────────────────────────────────────────────────────────────────────
  { id: 'administrator',    name: 'Administrator',                  short: 'ADMIN',      cat: 'HQ',      pl: 100 },
  { id: 'secnav',           name: 'Secretary of the Navy',          short: 'SecNav',     cat: 'HQ',      pl: 90  },
  { id: 'undersecnav',      name: 'Undersecretary of the Navy',     short: 'UnderSecNav',cat: 'HQ',      pl: 85  },
  { id: 'asst_secnav',      name: 'Assistant to the Secretary',     short: 'Asst SecNav',cat: 'HQ',      pl: 80  },
  { id: 'ncis_dir',         name: 'NCIS Director',                  short: 'NCIS Dir',   cat: 'HQ',      pl: 75  },
  { id: 'ncis_hicom',       name: 'NCIS HICOM',                     short: 'NCIS HICOM', cat: 'HQ',      pl: 72  },
  { id: 'cno',              name: 'Chief of Naval Operations',      short: 'CNO',        cat: 'HQ',      pl: 70  },
  { id: 'vcno',             name: 'Vice Chief of Naval Operations',  short: 'VCNO',       cat: 'HQ',      pl: 65  },
  { id: 'cnp',              name: 'Chief of Naval Personnel',       short: 'CNP',        cat: 'HQ',      pl: 60  },
  // ── Command / Mid ───────────────────────────────────────────────────────────
  { id: 'ncis_midcom',      name: 'NCIS MIDCOM',                    short: 'NCIS MIDCOM',cat: 'Command', pl: 55  },
  { id: 'admiral',          name: 'Admiral',                        short: 'ADM',        cat: 'Command', pl: 50  },
  { id: 'vice_admiral',     name: 'Vice Admiral',                   short: 'VADM',       cat: 'Command', pl: 48  },
  { id: 'rear_admiral_u',   name: 'Rear Admiral (Upper Half)',       short: 'RADM',       cat: 'Command', pl: 46  },
  { id: 'rear_admiral_l',   name: 'Rear Admiral (Lower Half)',       short: 'RDML',       cat: 'Command', pl: 44  },
  { id: 'mcpo',             name: 'Master Chief Petty Officer',     short: 'MCPO',       cat: 'Command', pl: 42  },
  { id: 'ncis_agent',       name: 'NCIS',                           short: 'NCIS',       cat: 'Command', pl: 40  },
  { id: 'captain',          name: 'Captain',                        short: 'CAPT',       cat: 'Command', pl: 38  },
  { id: 'commander',        name: 'Commander',                      short: 'CDR',        cat: 'Command', pl: 36  },
  { id: 'lt_commander',     name: 'Lieutenant Commander',           short: 'LCDR',       cat: 'Command', pl: 34  },
  { id: 'lieutenant',       name: 'Lieutenant',                     short: 'LT',         cat: 'Command', pl: 32  },
  { id: 'ltjg',             name: 'Lieutenant Junior Grade',        short: 'LTJG',       cat: 'Command', pl: 30  },
  { id: 'ensign',           name: 'Ensign',                         short: 'ENS',        cat: 'Command', pl: 28  },
  // ── Enlisted ────────────────────────────────────────────────────────────────
  { id: 'senior_chief',     name: 'Senior Chief Petty Officer',     short: 'SCPO',       cat: 'Enlisted',pl: 20  },
  { id: 'chief',            name: 'Chief Petty Officer',            short: 'CPO',        cat: 'Enlisted',pl: 18  },
  { id: 'po1',              name: 'Petty Officer First Class',      short: 'PO1',        cat: 'Enlisted',pl: 16  },
  { id: 'po2',              name: 'Petty Officer Second Class',     short: 'PO2',        cat: 'Enlisted',pl: 14  },
  { id: 'po3',              name: 'Petty Officer Third Class',      short: 'PO3',        cat: 'Enlisted',pl: 12  },
  { id: 'seaman',           name: 'Seaman',                         short: 'SN',         cat: 'Enlisted',pl: 10  },
  { id: 'seaman_apprentice',name: 'Seaman Apprentice',              short: 'SA',         cat: 'Enlisted',pl: 8   },
  { id: 'seaman_recruit',   name: 'Seaman Recruit',                 short: 'SR',         cat: 'Enlisted',pl: 5   },
];

// Default divisions (seeded into Firestore on first admin setup)
const DEFAULT_DIVISIONS = [
  { id: 'ncg',   name: 'Navy Ceremonial Guard',            short: 'NCG'   },
  { id: 'seals', name: 'Navy SEALs',                       short: 'SEALS' },
  { id: 'netc',  name: 'Naval Education Training Command', short: 'NETC'  },
  { id: 'ffc',   name: 'Fleet Forces Command',             short: 'FFC'   },
  { id: 'ndvl',  name: 'Navy Divisionless',                short: 'NDVL'  },
];

const EVENT_TYPES = [
  'Training Exercise',
  'Combat Operation',
  'Ceremonial Duty',
  'Inspection',
  'Briefing / Debrief',
  'Recruitment Drive',
  'Joint Operation',
  'Patrol',
  'Awards Ceremony',
  'Physical Training (PT)',
  'Custom Event',
];

// Permission level thresholds — keep in sync with Firestore rules & Cloud Functions
const PERM = {
  ADMIN_PANEL:      60,   // CNP+
  CREATE_USERS:     60,   // CNP+
  MANAGE_DIVISIONS: 90,   // SecNav+
  MANAGE_DIV_RANKS: 70,   // CNO+
  ARCHIVE_LOGS:     85,   // UnderSecNav+
  APPROVE_LOGS:     42,   // Lieutenant+
};

// ── Helpers ──────────────────────────────────────────────────
function getRankById(id) {
  return RANKS.find(r => r.id === id) || null;
}

function getRanksUpTo(maxPL) {
  return RANKS.filter(r => r.pl <= maxPL);
}

function hasPerm(userPL, required) {
  return userPL >= required;
}

function catBadge(cat) {
  if (cat === 'HQ')      return 'badge-hq';
  if (cat === 'Command') return 'badge-command';
  return 'badge-enlisted';
}
