# BusySync

Google Apps Script that syncs your personal and work Google Calendars — keeping your personal events private from work while mirroring work events back to you.

## The Problem

You have two Google accounts (personal + work). You need:
- **Colleagues to see you as busy** when you have personal events
- **To see your work events** from your personal devices
- **No personal event details** visible to your work account

Google has no built-in way to do this.

## How It Works

Two one-way syncs running every 5 minutes:

### 1. Busy Sync (Personal → Work)

Queries your personal calendar's free/busy times via the FreeBusy API and creates `[Busy]` blocks on your work primary calendar. Colleagues see you as unavailable. No event titles, descriptions, or attendees are exposed — just time ranges.

### 2. Mirror Sync (Work → Personal)

Copies your work events to a secondary "Work Mirror" calendar using `Events.import()` (no attendee notifications). Subscribe to this from your personal account instead of your primary work calendar. The busy blocks from sync #1 are excluded, so you don't see doubled events.

Mirror events are prefixed with `[brackets]` so you can tell them apart from real events at a glance.

## Privacy

- **Work sees:** Generic `[Busy]` blocks with no details (marked as private + opaque)
- **Personal sees:** Work event titles, times, locations, and attendee names (as plain text in the description — no email addresses in the attendees field)
- **Colleagues see:** Nothing different — the busy blocks just look like you blocked time
- **No emails are sent** to anyone — `Events.import()` never triggers notifications

## Setup

1. **Share your personal calendar** with your work email as "See only free/busy (hide details)" (from your personal account)

2. **Create an Apps Script project** at [script.google.com](https://script.google.com) from your work account. Paste `sync.gs`.

3. **Set `PERSONAL_CALENDAR_ID`** to your personal Gmail address.

4. **Create a "Work Mirror" calendar** on your work account: Google Calendar → `+` next to "Other calendars" → Create new calendar → name it exactly `Work Mirror`.

5. **Enable the Google Calendar API** advanced service: Editor sidebar → Services (+) → Google Calendar API → Add.

6. **Set the manifest**: In the Apps Script editor, go to Project Settings → check "Show appsscript.json in editor" → replace contents with `appsscript.json` from this repo.

7. **Run `initialSetup`**. Authorize when prompted.

8. **Share "Work Mirror"** with your personal email: Google Calendar → Settings → Work Mirror → Share with specific people → your personal email → "See all event details".

9. **Subscribe** to the Work Mirror calendar from your personal account.

10. **Unsubscribe** your personal account from your primary work calendar.

## Teardown

Run `teardown()` in the Apps Script editor. It removes all synced events from both calendars and deletes the trigger. The Work Mirror calendar itself is left intact (you created it manually).

## Required Scopes

| Scope | Why |
|-------|-----|
| `calendar.events` | Create/delete busy blocks and mirror events |
| `calendar.freebusy` | Query personal calendar availability |
| `calendar.readonly` | Look up the mirror calendar by name |
| `script.scriptapp` | Create/manage the 5-minute trigger |
| `script.send_mail` | Email you if the sync fails |
| `userinfo.email` | Get your email for failure notifications |

## Notes

- All-day personal events only sync if explicitly set to "Busy" (Google defaults them to "Free")
- The FreeBusy API merges adjacent busy periods — two back-to-back personal events become one `[Busy]` block
- Conference/Meet links are included in mirror events so you can join directly
- Uses `LockService` to prevent concurrent sync runs from colliding
- Only mirrors `default`, `fromGmail`, and `focusTime` event types
