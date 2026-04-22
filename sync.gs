// ============================================================
// Personal → Work "Busy" Sync + Work Mirror Calendar (v3)
// ============================================================
//
// TWO SYNCS IN ONE:
//
// 1. BUSY SYNC: Personal calendar busy times → "Busy" blocks
//    on your work primary calendar (so colleagues see you as
//    busy). Uses the FreeBusy API — no event details leak.
//
// 2. MIRROR SYNC: Work primary calendar events → a secondary
//    "Work Mirror" calendar, EXCLUDING the busy blocks from
//    sync #1. Subscribe to this mirror from your personal
//    account instead of the primary calendar. No doubled events.
//
// SETUP:
// 1. From your PERSONAL Google account, share your personal
//    calendar with your work email as "See only free/busy
//    (hide details)".
//
// 2. Open https://script.google.com from your WORK account.
//    Create a new project, paste this script.
//
// 3. Set PERSONAL_CALENDAR_ID below (your personal gmail).
//
// 4. Create a new calendar on your WORK account:
//    Google Calendar → "+" next to "Other calendars"
//    → "Create new calendar" → name it exactly "Work Mirror"
//    (must match MIRROR_CALENDAR_NAME below).
//
// 5. Enable the "Google Calendar API" advanced service:
//    Editor sidebar → Services (+) → Google Calendar API → Add
//
// 6. Run `initialSetup` once. Authorize when prompted.
//
// 7. Share the "Work Mirror" calendar with your personal email:
//    Google Calendar → Settings → "Work Mirror"
//    → Share with specific people → Add your personal email
//    → "See all event details"
//
// 8. From your PERSONAL account, subscribe to "Work Mirror".
//
// 9. Unsubscribe your personal account from your primary work
//    calendar. You won't need it anymore.
//
// ============================================================

// ── CONFIG ──────────────────────────────────────────────────

const PERSONAL_CALENDAR_ID = "XXXXXXXXXX@gmail.com";

// How far ahead to sync (days)
const SYNC_WINDOW_DAYS = 14;

// What the blocking events say on your work calendar
const BLOCK_TITLE = "Busy";

// Tags for identifying events created by each sync
const SYNC_TAG_KEY = "personalBusySync";
const SYNC_TAG_VALUE = "v2";
const MIRROR_TAG_KEY = "workMirrorSync";
const MIRROR_TAG_VALUE = "v1";

// Work calendar ID — "primary" means your default work calendar
const WORK_CALENDAR_ID = "primary";

// Name for the mirror calendar
const MIRROR_CALENDAR_NAME = "Work Mirror";

// Script property key where we store the mirror calendar ID
const MIRROR_CAL_PROP = "mirrorCalendarId";

// ── MAIN ────────────────────────────────────────────────────

function sync() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) {
    Logger.log("Sync skipped: another run is already in progress.");
    return;
  }
  try {
    const now = new Date();
    const horizon = new Date(
      now.getTime() + SYNC_WINDOW_DAYS * 24 * 60 * 60 * 1000
    );

    syncBusyBlocks_(now, horizon);
    syncMirror_(now, horizon);
  } catch (err) {
    Logger.log("Sync FAILED: " + err.message);
    notifyFailure_(err);
    throw err;
  } finally {
    lock.releaseLock();
  }
}

// ── BUSY SYNC (Personal → Work Primary) ─────────────────────

function syncBusyBlocks_(now, horizon) {
  const busySlots = getFreeBusy_(now, horizon);
  const existingBlocks = getExistingSyncEvents_(
    WORK_CALENDAR_ID, SYNC_TAG_KEY, SYNC_TAG_VALUE, now, horizon
  );

  const existingByKey = new Map();
  for (const evt of existingBlocks) {
    const startMs = new Date(evt.start.dateTime || evt.start.date).getTime();
    const endMs = new Date(evt.end.dateTime || evt.end.date).getTime();
    existingByKey.set(startMs + "|" + endMs, evt);
  }

  let created = 0;
  const busyKeys = new Set();
  for (const slot of busySlots) {
    const key = slot.start.getTime() + "|" + slot.end.getTime();
    busyKeys.add(key);

    if (!existingByKey.has(key)) {
      createBlockEvent_(slot.start, slot.end);
      created++;
    }
  }

  let removed = 0;
  for (const [key, evt] of existingByKey) {
    if (!busyKeys.has(key)) {
      Calendar.Events.remove(WORK_CALENDAR_ID, evt.id);
      removed++;
    }
  }

  Logger.log(
    `Busy sync: ${created} created, ${removed} removed, ` +
      `${busySlots.length} personal busy slots`
  );
}

// ── MIRROR SYNC (Work Primary → Secondary Calendar) ─────────

function syncMirror_(now, horizon) {
  const mirrorCalId = getMirrorCalendarId_();
  if (!mirrorCalId) {
    Logger.log("Mirror sync skipped: no mirror calendar found. Run initialSetup.");
    return;
  }

  // Get all events from work primary calendar
  const workEvents = listWorkEvents_(now, horizon);

  const MIRRORABLE_TYPES = new Set(["default", "fromGmail", "focusTime"]);

  const realEvents = workEvents.filter((evt) => {
    // Skip our own busy-sync blocks
    const props = evt.extendedProperties && evt.extendedProperties.private;
    if (props && props[SYNC_TAG_KEY] === SYNC_TAG_VALUE) return false;
    // Only mirror event types that import cleanly
    const type = evt.eventType || "default";
    return MIRRORABLE_TYPES.has(type);
  });

  // Get existing mirror events
  const mirrorEvents = getExistingSyncEvents_(
    mirrorCalId, MIRROR_TAG_KEY, MIRROR_TAG_VALUE, now, horizon
  );

  // Index mirror events by source event ID (array to handle duplicates)
  const mirrorBySourceId = new Map();
  for (const evt of mirrorEvents) {
    const props = evt.extendedProperties && evt.extendedProperties.private;
    if (props && props.sourceEventId) {
      const sourceId = props.sourceEventId;
      if (!mirrorBySourceId.has(sourceId)) {
        mirrorBySourceId.set(sourceId, []);
      }
      mirrorBySourceId.get(sourceId).push(evt);
    }
  }

  const realEventIds = new Set();
  let created = 0;
  let updated = 0;

  for (const evt of realEvents) {
    realEventIds.add(evt.id);
    const group = mirrorBySourceId.get(evt.id) || [];
    const [existing, ...dupes] = group;

    // Clean up any duplicates
    for (const dup of dupes) {
      Calendar.Events.remove(mirrorCalId, dup.id);
    }

    if (!existing) {
      importMirrorEvent_(mirrorCalId, evt);
      created++;
    } else if (eventChanged_(evt, existing)) {
      Calendar.Events.remove(mirrorCalId, existing.id);
      importMirrorEvent_(mirrorCalId, evt);
      updated++;
    }
  }

  // Remove mirror events whose source no longer exists
  let removed = 0;
  for (const [sourceId, group] of mirrorBySourceId) {
    if (!realEventIds.has(sourceId)) {
      for (const mirrorEvt of group) {
        Calendar.Events.remove(mirrorCalId, mirrorEvt.id);
        removed++;
      }
    }
  }

  Logger.log(
    `Mirror sync: ${created} created, ${updated} updated, ${removed} removed, ` +
      `${realEvents.length} work events mirrored`
  );
}

function importMirrorEvent_(mirrorCalId, sourceEvent) {
  const mirror = {
    iCalUID: sourceEvent.id + "_mirror_" + Date.now() + "@busysync",
    summary: "[" + (sourceEvent.summary || "No title") + "]",
    description: sourceEvent.description || "",
    location: sourceEvent.location || "",
    start: sourceEvent.start,
    end: sourceEvent.end,
    transparency: sourceEvent.transparency || "opaque",
    visibility: "default",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        [MIRROR_TAG_KEY]: MIRROR_TAG_VALUE,
        sourceEventId: sourceEvent.id,
        sourceUpdated: sourceEvent.updated,
      },
    },
  };

  // Attendees — safe to include with Events.import() (never sends notifications).
  // Set all to accepted so they display cleanly, not as pending invites.
  if (sourceEvent.attendees && sourceEvent.attendees.length > 0) {
    mirror.attendees = sourceEvent.attendees.map((a) => ({
      email: a.email,
      displayName: a.displayName || undefined,
      responseStatus: a.responseStatus || "accepted",
      self: false,
    }));
  }

  // Color — only include if present
  if (sourceEvent.colorId) {
    mirror.colorId = sourceEvent.colorId;
  }

  // Conference data — lets you join meetings directly from the mirror
  if (sourceEvent.conferenceData) {
    mirror.conferenceData = sourceEvent.conferenceData;
  }

  const params = sourceEvent.conferenceData
    ? { conferenceDataVersion: 1 }
    : {};

  Calendar.Events.import(mirror, mirrorCalId, params);
}

function eventChanged_(sourceEvent, mirrorEvent) {
  const mirrorProps =
    mirrorEvent.extendedProperties && mirrorEvent.extendedProperties.private;
  if (!mirrorProps) return true;

  // Compare the source event's updated timestamp
  return mirrorProps.sourceUpdated !== sourceEvent.updated;
}

function listWorkEvents_(timeMin, timeMax) {
  const results = [];
  let pageToken = null;

  do {
    const params = {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 250,
      orderBy: "startTime",
    };
    if (pageToken) params.pageToken = pageToken;

    const page = Calendar.Events.list(WORK_CALENDAR_ID, params);
    if (page.items) results.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return results;
}

// ── FREEBUSY QUERY ──────────────────────────────────────────

function getFreeBusy_(timeMin, timeMax) {
  const request = {
    timeMin: timeMin.toISOString(),
    timeMax: timeMax.toISOString(),
    timeZone: Session.getScriptTimeZone(),
    items: [{ id: PERSONAL_CALENDAR_ID }],
  };

  const response = Calendar.Freebusy.query(request);
  const calData = response.calendars[PERSONAL_CALENDAR_ID];

  if (calData.errors && calData.errors.length > 0) {
    throw new Error(
      "FreeBusy query error: " +
        calData.errors.map((e) => e.reason).join(", ")
    );
  }

  const busyArray = calData.busy || [];
  return busyArray.map((slot) => ({
    start: new Date(slot.start),
    end: new Date(slot.end),
  }));
}

// ── SHARED HELPERS ──────────────────────────────────────────

function createBlockEvent_(start, end) {
  const event = {
    summary: "[" + BLOCK_TITLE + "]",
    start: { dateTime: start.toISOString() },
    end: { dateTime: end.toISOString() },
    colorId: "2", // Sage
    visibility: "private",
    transparency: "opaque",
    reminders: { useDefault: false, overrides: [] },
    extendedProperties: {
      private: {
        [SYNC_TAG_KEY]: SYNC_TAG_VALUE,
      },
    },
  };

  Calendar.Events.insert(event, WORK_CALENDAR_ID);
}

function getExistingSyncEvents_(calendarId, tagKey, tagValue, timeMin, timeMax) {
  const results = [];
  let pageToken = null;

  do {
    const params = {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      privateExtendedProperty: tagKey + "=" + tagValue,
      singleEvents: true,
      showDeleted: false,
      maxResults: 250,
    };
    if (pageToken) params.pageToken = pageToken;

    const page = Calendar.Events.list(calendarId, params);
    if (page.items) results.push(...page.items);
    pageToken = page.nextPageToken;
  } while (pageToken);

  return results;
}

// ── MIRROR CALENDAR MANAGEMENT ──────────────────────────────

function getMirrorCalendarId_() {
  // Check cached ID first
  const cached = PropertiesService.getScriptProperties().getProperty(MIRROR_CAL_PROP);
  if (cached) {
    try {
      Calendar.Calendars.get(cached);
      return cached;
    } catch (e) {
      // Cached ID is stale, look up by name
      PropertiesService.getScriptProperties().deleteProperty(MIRROR_CAL_PROP);
    }
  }

  // Find by name using CalendarApp (works with narrower scopes)
  const cals = CalendarApp.getCalendarsByName(MIRROR_CALENDAR_NAME);
  if (cals.length === 0) {
    return null;
  }

  const id = cals[0].getId();
  // Cache for future runs
  PropertiesService.getScriptProperties().setProperty(MIRROR_CAL_PROP, id);
  return id;
}

// ── ERROR NOTIFICATION ──────────────────────────────────────

function notifyFailure_(err) {
  try {
    const email = Session.getActiveUser().getEmail();
    if (!email) return;

    MailApp.sendEmail({
      to: email,
      subject: "⚠ Calendar busy-sync failed",
      body:
        "Your personal→work calendar sync script failed.\n\n" +
        "Error: " + err.message + "\n\n" +
        "Common causes:\n" +
        "- Personal calendar is no longer shared with your work account\n" +
        "- Google Calendar API advanced service was disabled\n" +
        "- API quota exceeded\n\n" +
        "The trigger will keep retrying every 5 minutes. " +
        "If the problem persists, Apps Script may auto-disable the trigger.",
    });
  } catch (mailErr) {
    Logger.log("Could not send failure notification: " + mailErr.message);
  }
}

// ── SETUP & TEARDOWN ────────────────────────────────────────

function initialSetup() {
  // Remove existing sync triggers
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === "sync") {
      ScriptApp.deleteTrigger(t);
    }
  }

  // Find mirror calendar
  const mirrorCalId = getMirrorCalendarId_();
  if (!mirrorCalId) {
    Logger.log(
      `ERROR: No calendar named "${MIRROR_CALENDAR_NAME}" found.\n` +
        `Create it first: Google Calendar → "+" next to "Other calendars"\n` +
        `→ "Create new calendar" → name it exactly "${MIRROR_CALENDAR_NAME}"`
    );
    return;
  }

  Logger.log(`Found mirror calendar: ${mirrorCalId}`);
  Logger.log("Running initial sync now...");
  sync();

  ScriptApp.newTrigger("sync").timeBased().everyMinutes(5).create();
  Logger.log("Trigger created. Syncing every 5 minutes.");
}

// Removes ALL synced events, the mirror calendar, and the trigger.
function teardown() {
  const now = new Date();
  const past = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
  const future = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

  // Remove busy blocks from primary calendar
  const busyEvents = getExistingSyncEvents_(
    WORK_CALENDAR_ID, SYNC_TAG_KEY, SYNC_TAG_VALUE, past, future
  );
  for (const evt of busyEvents) {
    Calendar.Events.remove(WORK_CALENDAR_ID, evt.id);
  }

  // Clear mirror events (but keep the calendar — it was manually created)
  const mirrorCalId = getMirrorCalendarId_();
  if (mirrorCalId) {
    const mirrorEvents = getExistingSyncEvents_(
      mirrorCalId, MIRROR_TAG_KEY, MIRROR_TAG_VALUE, past, future
    );
    for (const evt of mirrorEvents) {
      Calendar.Events.remove(mirrorCalId, evt.id);
    }
    Logger.log(`Removed ${mirrorEvents.length} mirror events.`);
    PropertiesService.getScriptProperties().deleteProperty(MIRROR_CAL_PROP);
  }

  // Remove triggers
  for (const t of ScriptApp.getProjectTriggers()) {
    if (t.getHandlerFunction() === "sync") {
      ScriptApp.deleteTrigger(t);
    }
  }

  Logger.log(
    `Teardown complete: removed ${busyEvents.length} busy blocks, ` +
      `cleared mirror events, and removed sync trigger.`
  );
}
