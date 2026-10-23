# Study Tracker

A small study timer and log, styled after YPT. Plain HTML, CSS and JavaScript with no build step, hosted on GitHub Pages.

**Live:** https://vasanthkumard1248.github.io/study-tracker/

## Features

- **Timer:** pick a subject, then Start and Stop. Each Start→Stop is one focus session. The timer survives reloads and closed tabs because it stores the start time, not a counter. While it runs, it asks the browser to keep the screen awake.
- **Day:** total study time, max focus (longest single session), start and end time, a cumulative chart of today against yesterday, and a breakdown by subject.
- **Week:** stacked bars per day, the week total and the daily average.
- **Month:** a calendar heat map with YPT's 0+ / 4+ / 7+ / 10+ / 12+ hour bands, and the month total.
- **Days run from 5:00 to 5:00**, so a late-night session counts toward the day you started it.
- Add or delete sessions by hand, manage subjects, and export or import JSON.
- **Installable:** in Safari, choose Share → Add to Home Screen. It also opens offline.

## Sync across devices

Data is saved in each browser's localStorage. To keep your phone and laptop in step, the app can sync to a JSON file in a **private** repo through the GitHub API:

1. Create a fine-grained token at https://github.com/settings/personal-access-tokens/new
   - Repository access: **Only select repositories** → `study-tracker-data`
   - Permissions → Repository → **Contents: Read and write**
2. In the app, open ⚙ and fill in Owner `VasanthKumarD1248`, Repo `study-tracker-data`, Path `sessions.json`, and the token. Then tap **Save & sync**.
3. Repeat on each device. The app syncs when it opens, when it regains focus, and after every change. Records merge by id, so the two devices never overwrite each other.

The token stays in that browser's localStorage. It is never sent anywhere except `api.github.com`.

## Data format

`sessions.json`:

```json
{
  "subjects": [{ "id": "dsa", "name": "DSA", "color": "#bfe9ef", "updated": 0 }],
  "sessions": [{ "id": "…", "subjectId": "dsa", "start": 1761120540000, "end": 1761124860000, "updated": 1761124860000 }]
}
```

Times are Unix milliseconds. Deleted records stay in the file with `"deleted": true` so the delete can sync to other devices.
